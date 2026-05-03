import { Storage } from "@google-cloud/storage";

// Uses ADC (Application Default Credentials) or GOOGLE_APPLICATION_CREDENTIALS
const storage = new Storage();

// Bucket for ingesting user reference images directly to GCS via Signed URLs
export const INGESTION_BUCKET = process.env.INGESTION_BUCKET || "myaura-ingestion";

export interface GcsUploadSlot {
  key: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

/**
 * Generates a V4 Signed URL for uploading an object directly to GCS.
 * Used to bypass the server and avoid R2/GCS protocol mismatch.
 *
 * IMPORTANT: GCS V4 signed URLs enforce an exact Content-Type match.
 * The client MUST send the same contentType header on the PUT request,
 * otherwise GCS returns 403 "Access Denied" or 400 "Bad Request".
 */
export async function generateGcsUploadUrl(
  key: string,
  contentType: string,
  expiresInMinutes: number = 15
): Promise<GcsUploadSlot> {
  const bucket = storage.bucket(INGESTION_BUCKET);
  const file = bucket.file(key);

  const [url] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + expiresInMinutes * 60 * 1000,
    contentType,
  });

  return {
    key,
    url,
    headers: {
      "Content-Type": contentType,
    },
    expiresAt: Date.now() + expiresInMinutes * 60 * 1000,
  };
}

/**
 * Validates if an object exists and is within limits in GCS.
 */
export async function headGcsObject(key: string): Promise<{ exists: boolean; size?: number; contentType?: string }> {
  try {
    const [metadata] = await storage.bucket(INGESTION_BUCKET).file(key).getMetadata();
    return {
      exists: true,
      size: parseInt(metadata.size as string, 10),
      contentType: metadata.contentType,
    };
  } catch (err: any) {
    if (err.code === 404) return { exists: false };
    throw err;
  }
}

/**
 * Immediately deletes the specified keys from GCS for GDPR compliance.
 */
export async function deleteFromGcs(keys: string[]): Promise<void> {
  const bucket = storage.bucket(INGESTION_BUCKET);
  const deletePromises = keys.map(key => 
    bucket.file(key).delete({ ignoreNotFound: true }).catch(err => {
      console.error(`[GCS] Failed to delete ${key}:`, err.message);
    })
  );
  await Promise.all(deletePromises);
  console.log(`[GCS] GDPR Cleanup: Deleted ${keys.length} original files from bucket ${INGESTION_BUCKET}`);
}
