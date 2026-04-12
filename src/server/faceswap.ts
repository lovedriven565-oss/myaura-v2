import Replicate from "replicate";

// lucataco/faceswap — stable, well-tested faceswap model on Replicate
const FACESWAP_MODEL = "lucataco/faceswap:9a4298548422074c3f57258c5d544497314ae4112df80d116f0d2109e843d20d";

/**
 * Swaps the face from swapBase64 (user's original photo) into targetBase64 (Gemini-generated base).
 * Returns the result as base64-encoded image string.
 */
export async function swapFace(
  targetBase64: string,
  swapBase64: string,
  mimeType: string = "image/jpeg"
): Promise<string> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN is not configured");

  const replicate = new Replicate({ auth: token });

  console.log("[FaceSwap] Calling Replicate faceswap model...");

  const output = await replicate.run(FACESWAP_MODEL, {
    input: {
      target_image: `data:${mimeType};base64,${targetBase64}`,
      swap_image: `data:${mimeType};base64,${swapBase64}`,
    },
  }) as unknown as string;

  if (!output || typeof output !== "string") {
    throw new Error("[FaceSwap] Replicate returned no output URL");
  }

  console.log("[FaceSwap] Downloading result from Replicate...");
  const res = await fetch(output);
  if (!res.ok) {
    throw new Error(`[FaceSwap] Failed to download result: ${res.status} ${res.statusText}`);
  }

  const buf = await res.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  console.log("[FaceSwap] Done. Result size:", Math.round(base64.length / 1024), "KB (base64)");
  return base64;
}
