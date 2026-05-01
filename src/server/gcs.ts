import { Storage } from "@google-cloud/storage";
import { ImageRef } from "./ai.js";

// Uses ADC (Application Default Credentials) or GOOGLE_APPLICATION_CREDENTIALS
const storage = new Storage();

// We need a bucket for the tuning datasets
// Defaulting to "myaura-vertex-tuning" but can be overridden in env
export const TUNING_BUCKET_NAME = process.env.VERTEX_TUNING_BUCKET || "myaura-vertex-tuning";

/**
 * Uploads user reference images to GCS for Vertex AI Subject Tuning.
 * 
 * @param generationId The unique ID of the generation (used as folder name).
 * @param refs Array of ImageRef (base64 + mimeType).
 * @returns The GCS URI of the uploaded dataset folder (e.g. gs://bucket/folder/)
 */
export async function uploadTuningDataset(generationId: string, refs: ImageRef[]): Promise<string> {
  const bucket = storage.bucket(TUNING_BUCKET_NAME);
  
  // Ensure bucket exists (or at least log if we suspect it doesn't)
  // In a real prod environment we assume terraform/operator created it.
  
  const gcsFolder = `datasets/${generationId}/`;
  
  const uploadPromises = refs.map(async (ref, index) => {
    // Generate a file extension based on mimeType
    let ext = "jpg";
    if (ref.mimeType.includes("png")) ext = "png";
    else if (ref.mimeType.includes("webp")) ext = "webp";
    else if (ref.mimeType.includes("heic")) ext = "heic";

    const fileName = `${gcsFolder}ref_${index}.${ext}`;
    const file = bucket.file(fileName);
    
    const buffer = Buffer.from(ref.base64, "base64");
    
    await file.save(buffer, {
      contentType: ref.mimeType,
      resumable: false, // For small images, non-resumable is faster
    });
  });

  await Promise.all(uploadPromises);
  
  // Vertex AI TuningJob expects trainingDatasetUri to be a JSONL file,
  // not a folder. Build a JSONL manifest that references each uploaded image.
  const jsonlLines = refs.map((ref, index) => {
    let ext = "jpg";
    if (ref.mimeType.includes("png")) ext = "png";
    else if (ref.mimeType.includes("webp")) ext = "webp";
    else if (ref.mimeType.includes("heic")) ext = "heic";

    const imageUri = `gs://${TUNING_BUCKET_NAME}/${gcsFolder}ref_${index}.${ext}`;

    // Use Vertex AI multimodal tuning JSONL format (image + text pair)
    const record = {
      contents: [
        {
          role: "user",
          parts: [
            { text: `Portrait of a person, reference photo ${index + 1}` },
            {
              fileData: {
                mimeType: ref.mimeType,
                fileUri: imageUri,
              },
            },
          ],
        },
      ],
    };

    return JSON.stringify(record);
  });

  const jsonlContent = jsonlLines.join("\n");
  const jsonlFileName = `${gcsFolder}dataset.jsonl`;
  const jsonlFile = bucket.file(jsonlFileName);

  await jsonlFile.save(jsonlContent, {
    contentType: "application/jsonl",
    resumable: false,
  });

  const jsonlUri = `gs://${TUNING_BUCKET_NAME}/${jsonlFileName}`;
  
  console.log(`[GCS] Uploaded ${refs.length} images + dataset.jsonl to gs://${TUNING_BUCKET_NAME}/${gcsFolder}`);
  
  return jsonlUri;
}

/**
 * Deletes the tuning dataset for a given generation to save storage costs.
 */
export async function deleteTuningDataset(generationId: string): Promise<void> {
  try {
    const bucket = storage.bucket(TUNING_BUCKET_NAME);
    const prefix = `datasets/${generationId}/`;
    
    console.log(`[GCS] Deleting dataset: gs://${TUNING_BUCKET_NAME}/${prefix}`);
    
    await bucket.deleteFiles({ prefix });
    
    console.log(`[GCS] Successfully deleted dataset for generation ${generationId}`);
  } catch (err: any) {
    console.error(`[GCS] Error deleting dataset for generation ${generationId}:`, err);
  }
}
