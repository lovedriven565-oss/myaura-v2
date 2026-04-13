import Replicate from "replicate";
import sharp from "sharp";

// xiankgx/face-swap — robust model supporting identity weight and no forced GFPGAN
const FACESWAP_MODEL = "xiankgx/face-swap:cff87316e31787df12002c9e20a78a017a36cb31fde9862d8dedd15ab29b7288";

/**
 * Swaps the face from swapBase64 (user's original photo) into targetBase64 (Gemini-generated base).
 * Returns the result as base64-encoded image string.
 * Compatible with Replicate SDK v1.x (FileOutput return type).
 */
export async function swapFace(
  targetBase64: string,
  swapBase64: string,
  mimeType: string = "image/jpeg"
): Promise<string> {
  // TRACE 1: Token check
  const token = process.env.REPLICATE_API_TOKEN;
  console.log("[FACESWAP TRACE 1] Token exists:", !!token, "| Token length:", token?.length ?? 0);
  if (!token) throw new Error("REPLICATE_API_TOKEN is not configured or empty");

  // OPTIMIZATION: Compress and resize user's source face image to 1024px to save bandwidth and speed up processing
  const swapBuffer = Buffer.from(swapBase64, "base64");
  const optimizedSwapBuffer = await sharp(swapBuffer)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const optimizedSwapBase64 = optimizedSwapBuffer.toString("base64");
  console.log(`[FACESWAP TRACE 1.5] Optimized user image from ${Math.round(swapBase64.length / 1024)}KB to ${Math.round(optimizedSwapBase64.length / 1024)}KB`);

  // TRACE 2: SDK init
  const replicate = new Replicate({ auth: token });
  console.log("[FACESWAP TRACE 2] Replicate client created");

  // TRACE 3: Input sizes + visual audit (first 50 chars of base64)
  console.log(
    `[FACESWAP TRACE 3] Inputs — target: ${Math.round(targetBase64.length / 1024)}KB, swap(opt): ${Math.round(optimizedSwapBase64.length / 1024)}KB, mime: ${mimeType}`
  );
  console.log(`[FACESWAP VISUAL AUDIT - INPUTS]`);
  console.log(`  Target (Gemini): data:${mimeType};base64,${targetBase64.slice(0, 50)}...`);
  console.log(`  Swap (User face): data:image/jpeg;base64,${optimizedSwapBase64.slice(0, 50)}...`);

  // TRACE 4: Calling model
  console.log("[FACESWAP TRACE 4] Calling replicate.run()...");
  const t0 = Date.now();

  const inputParams = {
      target_image: `data:${mimeType};base64,${targetBase64}`,
      source_image: `data:image/jpeg;base64,${optimizedSwapBase64}`,
      weight: 0.85,                  // Maximum resemblance to source face
    };

  console.log(`[FACESWAP VISUAL AUDIT - PARAMETERS]`);
  console.log(`  weight (identity): ${inputParams.weight}`);
  console.log(`  face_enhancer: Disabled (preventing mannequin effect)`);

  const output = await replicate.run(FACESWAP_MODEL, { input: inputParams });

  const elapsed = Date.now() - t0;
  console.log(`[FACESWAP TRACE 5] replicate.run() returned in ${elapsed}ms | type: ${typeof output} | value: ${String(output).slice(0, 120)}`);

  // Replicate SDK v1.x returns FileOutput objects, not plain strings.
  // FileOutput implements toString() which returns the URL.
  // We use String() to handle both FileOutput and legacy plain string.
  const outputUrl = String(output);

  console.log(`[FACESWAP VISUAL AUDIT - OUTPUT]`);
  console.log(`  Replicate result URL: ${outputUrl}`);
  console.log(`  (Open this URL in browser to see Stage 2 result - AFTER FaceSwap)`);

  if (!outputUrl || outputUrl === "undefined" || outputUrl === "null") {
    throw new Error(`[FaceSwap] Replicate returned empty output. Raw: ${JSON.stringify(output)}`);
  }

  // TRACE 6: Download
  console.log("[FACESWAP TRACE 6] Downloading from URL:", outputUrl.slice(0, 100));
  const res = await fetch(outputUrl);
  if (!res.ok) {
    throw new Error(`[FaceSwap] Download failed: ${res.status} ${res.statusText} — URL: ${outputUrl.slice(0, 80)}`);
  }

  const buf = await res.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");

  // TRACE 7: Done
  console.log(`[FACESWAP TRACE 7] SUCCESS. Result size: ${Math.round(base64.length / 1024)}KB`);
  return base64;
}
