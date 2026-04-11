import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import path from "path";

export interface IStorage {
  save(fileBuffer: Buffer, originalName: string, type: "original" | "result"): Promise<string>;
  delete(filepath: string): Promise<void>;
  get(filepath: string): Promise<Buffer | null>;
}

export class R2Storage implements IStorage {
  private s3: S3Client;
  private bucketName: string;
  private publicBaseUrl: string;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = process.env.R2_BUCKET_NAME || "myaura-bucket";
    this.publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";

    if (!accountId || !accessKeyId || !secretAccessKey) {
      console.warn("R2 credentials missing. Storage will fail.");
    }

    const endpoint = process.env.R2_S3_ENDPOINT || `https://${accountId}.eu.r2.cloudflarestorage.com`;

    this.s3 = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: accessKeyId || "",
        secretAccessKey: secretAccessKey || "",
      },
    });
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
}

export const storage = new R2Storage();
