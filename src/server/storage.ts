import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import path from "path";

export interface PresignedUploadSlot {
  /** Final R2 object key (e.g. "uploads/123456/<uuid>.jpg") */
  key: string;
  /** Presigned URL the client must PUT the file body to */
  url: string;
  /** Required headers the client MUST send on the PUT — the signature covers them */
  headers: Record<string, string>;
  /** Unix timestamp (ms) when the URL stops being valid */
  expiresAt: number;
}

export interface ObjectMetadata {
  exists: boolean;
  size: number | null;
  contentType: string | null;
  lastModified: Date | null;
}

export interface IStorage {
  save(fileBuffer: Buffer, originalName: string, type: "original" | "result"): Promise<string>;
  delete(filepath: string): Promise<void>;
  get(filepath: string): Promise<Buffer | null>;
  /**
   * Mint a presigned PUT URL. The signature locks Content-Type and
   * Content-Length, so the client cannot upload a different MIME or a
   * file that exceeds the declared size.
   */
  presignPut(key: string, contentType: string, contentLength: number, ttlSec: number): Promise<PresignedUploadSlot>;
  /**
   * Read object metadata without downloading the body. Used to verify
   * the client actually uploaded the file and it matches the declared
   * size/type before we kick off generation.
   */
  headObject(key: string): Promise<ObjectMetadata>;
  /**
   * List keys under a prefix (used by retention cron to find orphaned uploads).
   * Returns at most `maxKeys` entries per call.
   */
  listByPrefix(prefix: string, maxKeys?: number, continuationToken?: string): Promise<{
    keys: { key: string; lastModified: Date | null; size: number }[];
    nextContinuationToken: string | null;
  }>;
}

export class R2Storage implements IStorage {
  private s3: S3Client;
  private bucketName: string;
  private publicBaseUrl: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;
    this.publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";

    // Fail-fast: missing creds / bucket would otherwise surface as cryptic
    // `NoSuchBucket` or signature errors on the first upload. Better to die
    // at startup with a clear message than silently mis-route to a default.
    const missing: string[] = [];
    if (!accountId) missing.push("R2_ACCOUNT_ID");
    if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
    if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
    if (!bucketName) missing.push("R2_BUCKET_NAME");
    if (missing.length > 0) {
      throw new Error(`[R2] Missing required env vars: ${missing.join(", ")}`);
    }

    this.bucketName = bucketName!;

    // R2 jurisdiction is encoded in the endpoint host. A bucket is visible
    // ONLY through the endpoint of the jurisdiction it was created in:
    //   default / automatic : https://<acc>.r2.cloudflarestorage.com
    //   EU                  : https://<acc>.eu.r2.cloudflarestorage.com
    //   FedRAMP             : https://<acc>.fedramp.r2.cloudflarestorage.com
    // Default fallback is the automatic jurisdiction (what Cloudflare Dashboard
    // creates by default). Override with R2_S3_ENDPOINT when the bucket lives
    // in a specific jurisdiction.
    const endpoint = process.env.R2_S3_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3 = new S3Client({
      region: "auto",
      endpoint,
      // Cloudflare recommends path-style for R2 S3 API. Virtual-hosted-style
      // (<bucket>.<endpoint>) works for simple names but has known edge cases
      // (bucket names with dots, certain SDK versions). Path-style is safer.
      forcePathStyle: true,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });

    // Diagnostic (no secrets): lets operator spot endpoint/jurisdiction
    // mismatches without reading the env file.
    console.log(
      `[R2] endpoint=${endpoint} bucket=${this.bucketName} pathStyle=true ` +
      `publicBase=${this.publicBaseUrl || "<none>"}`
    );
  }

  async save(fileBuffer: Buffer, originalName: string, type: "original" | "result"): Promise<string> {
    const ext = path.extname(originalName) || ".jpg";
    // Include originalName prefix for auditability (generationId embedded by callers)
    // Sanitize to alphanumeric/dash/underscore only to prevent path traversal
    const safePrefix = originalName.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 80);
    const filename = `${type}/${safePrefix}_${uuidv4()}${ext}`;
    
    // Determine content type
    let contentType = "image/jpeg";
    if (ext.toLowerCase() === ".png") contentType = "image/png";
    if (ext.toLowerCase() === ".webp") contentType = "image/webp";

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: filename,
      Body: fileBuffer,
      ContentType: contentType,
    });

    await this.s3.send(command);
    return filename; // Return just the key
  }

  async delete(filename: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: filename,
    });
    try {
      await this.s3.send(command);
    } catch (e) {
      console.error(`Failed to delete ${filename} from R2:`, e);
    }
  }

  async get(filename: string): Promise<Buffer | null> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: filename,
    });
    
    try {
      const response = await this.s3.send(command);
      if (response.Body) {
        const chunks: any[] = [];
        for await (const chunk of response.Body as any) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }
      return null;
    } catch (e) {
      console.error(`Failed to get ${filename} from R2:`, e);
      return null;
    }
  }

  async presignPut(
    key: string,
    contentType: string,
    contentLength: number,
    ttlSec: number
  ): Promise<PresignedUploadSlot> {
    // Bind Content-Type AND Content-Length into the signature so the client
    // cannot swap the MIME or upload a larger file than was declared. If the
    // PUT headers do not match exactly, R2 rejects with 403 SignatureDoesNotMatch.
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });

    const url = await getSignedUrl(this.s3, command, {
      expiresIn: ttlSec,
      // Both headers MUST be in the signed list — otherwise R2 ignores them on PUT
      // and the size/type enforcement is defeated.
      signableHeaders: new Set(["content-type", "content-length"]),
    });

    return {
      key,
      url,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(contentLength),
      },
      expiresAt: Date.now() + ttlSec * 1000,
    };
  }

  async headObject(key: string): Promise<ObjectMetadata> {
    try {
      const response = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key })
      );
      return {
        exists: true,
        size: response.ContentLength ?? null,
        contentType: response.ContentType ?? null,
        lastModified: response.LastModified ?? null,
      };
    } catch (e: any) {
      // R2 returns 404 NotFound / NoSuchKey for missing objects; surface as exists=false
      const status = e?.$metadata?.httpStatusCode;
      if (status === 404 || e?.name === "NotFound" || e?.name === "NoSuchKey") {
        return { exists: false, size: null, contentType: null, lastModified: null };
      }
      console.error(`[R2] headObject unexpected error for ${key}:`, e?.message || e);
      throw e;
    }
  }

  async listByPrefix(
    prefix: string,
    maxKeys: number = 1000,
    continuationToken?: string
  ): Promise<{
    keys: { key: string; lastModified: Date | null; size: number }[];
    nextContinuationToken: string | null;
  }> {
    const response = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        MaxKeys: maxKeys,
        ContinuationToken: continuationToken,
      })
    );

    const keys = (response.Contents || [])
      .filter(obj => obj.Key)
      .map(obj => ({
        key: obj.Key!,
        lastModified: obj.LastModified ?? null,
        size: obj.Size ?? 0,
      }));

    return {
      keys,
      nextContinuationToken: response.IsTruncated ? response.NextContinuationToken ?? null : null,
    };
  }
}

export const storage = new R2Storage();
