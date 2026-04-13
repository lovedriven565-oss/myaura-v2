import Replicate from "replicate";

// lucataco/faceswap — stable, well-tested faceswap model on Replicate
const FACESWAP_MODEL = "lucataco/faceswap:9a4298548422074c3f57258c5d544497314ae4112df80d116f0d2109e843d20d";

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

  // TRACE 2: SDK init
  const replicate = new Replicate({ auth: token });
  console.log("[FACESWAP TRACE 2] Replicate client created");

  // TRACE 3: Input sizes + visual audit (first 50 chars of base64)
  console.log(
    `[FACESWAP TRACE 3] Inputs — target: ${Math.round(targetBase64.length / 1024)}KB, swap: ${Math.round(swapBase64.length / 1024)}KB, mime: ${mimeType}`
  );
  console.log(`[FACESWAP VISUAL AUDIT - INPUTS]`);
  console.log(`  Target (Gemini): data:${mimeType};base64,${targetBase64.slice(0, 50)}...`);
  console.log(`  Swap (User face): data:${mimeType};base64,${swapBase64.slice(0, 50)}...`);

  // TRACE 4: Calling model
  console.log("[FACESWAP TRACE 4] Calling replicate.run()...");
  const t0 = Date.now();

  const inputParams = {
      target_image: `data:${mimeType};base64,${targetBase64}`,
      swap_image: `data:${mimeType};base64,${swapBase64}`,
      face_enhancer: "gfpgan",       // GFPGAN face restoration — sharper, more likeness
      output_quality: 100,           // max JPEG quality (0-100)
    };

  console.log(`[FACESWAP VISUAL AUDIT - PARAMETERS]`);
  console.log(`  face_enhancer: ${inputParams.face_enhancer}`);
  console.log(`  output_quality: ${inputParams.output_quality}`);
  console.log(`  (Note: lucataco/faceswap does not support weight/similarity parameters in current version)`);

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
