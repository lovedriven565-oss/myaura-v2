import Replicate from "replicate";
import sharp from "sharp";

// xiankgx/face-swap — robust model supporting identity weight and no forced GFPGAN
type ReplicateModelRef = `${string}/${string}` | `${string}/${string}:${string}`;

const PREMIUM_FACESWAP_MODEL = "easel/advanced-face-swap" as const;
const FACESWAP_MODEL = "xiankgx/face-swap:cff87316e31787df12002c9e20a78a017a36cb31fde9862d8dedd15ab29b7288" as const;
const FALLBACK_FACESWAP_MODEL = "codeplugtech/face-swap" as const;
const SOURCE_FACE_MAX_BYTES = 500 * 1024;
const SOURCE_FACE_MAX_DIMENSION = 1280;
const IDENTITY_WEIGHT = 0.9;
const FACESWAP_TOTAL_TIMEOUT_MS = 45_000;

function detectMimeTypeFromBase64(base64: string): string {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}

async function normalizeTargetImage(base64: string): Promise<string> {
  const inputBuffer = Buffer.from(base64, "base64");
  return sharp(inputBuffer)
    .rotate()
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer()
    .then((buffer) => buffer.toString("base64"));
}

async function optimizeSourceFace(base64: string): Promise<string> {
  const inputBuffer = Buffer.from(base64, "base64");
  const qualities = [95, 92, 90, 88, 85];
  let bestBuffer: Uint8Array = inputBuffer;

  for (const quality of qualities) {
    const candidate = await sharp(inputBuffer)
      .rotate()
      .resize(SOURCE_FACE_MAX_DIMENSION, SOURCE_FACE_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    bestBuffer = candidate;
    if (candidate.length <= SOURCE_FACE_MAX_BYTES) {
      break;
    }
  }

  return Buffer.from(bestBuffer).toString("base64");
}

function extractOutputUrl(output: unknown): string {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = extractOutputUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    for (const key of ["output", "image", "result", "url"]) {
      const url = extractOutputUrl(record[key]);
      if (url) return url;
    }
  }

  const fallback = String(output);
  return fallback.startsWith("http://") || fallback.startsWith("https://") ? fallback : "";
}

async function downloadOutputAsBase64(output: unknown): Promise<string> {
  const firstOutput = Array.isArray(output) ? output[0] : output;

  if (firstOutput && typeof firstOutput === "object" && "arrayBuffer" in firstOutput && typeof firstOutput.arrayBuffer === "function") {
    const arrayBuffer = await firstOutput.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  }

  const outputUrl = extractOutputUrl(output);
  if (!outputUrl || outputUrl === "undefined" || outputUrl === "null") {
    throw new Error(`[FaceSwap] Replicate returned empty output. Raw: ${String(output)}`);
  }

  console.log("[FACESWAP TRACE 6] Downloading from URL:", outputUrl.slice(0, 100));
  const res = await fetch(outputUrl);
  if (!res.ok) {
    throw new Error(`[FaceSwap] Download failed: ${res.status} ${res.statusText} — URL: ${outputUrl.slice(0, 80)}`);
  }

  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

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
  const token = process.env.REPLICATE_API_TOKEN;
  console.log("[FACESWAP TRACE 1] Token exists:", !!token, "| Token length:", token?.length ?? 0);
  if (!token) throw new Error("REPLICATE_API_TOKEN is not configured or empty");

  const detectedTargetMimeType = detectMimeTypeFromBase64(targetBase64);
  const detectedSourceMimeType = detectMimeTypeFromBase64(swapBase64);
  const normalizedTargetBase64 = await normalizeTargetImage(targetBase64);
  const optimizedSwapBase64 = await optimizeSourceFace(swapBase64);
  console.log(
    `[FACESWAP TRACE 1.5] Target mime detected: ${detectedTargetMimeType} | declared mime: ${mimeType} | normalized target: ${Math.round(normalizedTargetBase64.length / 1024)}KB`
  );
  console.log(
    `[FACESWAP TRACE 1.6] Source mime detected: ${detectedSourceMimeType} | optimized user image from ${Math.round(swapBase64.length / 1024)}KB to ${Math.round(optimizedSwapBase64.length / 1024)}KB`
  );

  const replicate = new Replicate({ auth: token });
  console.log("[FACESWAP TRACE 2] Replicate client created");

  console.log(
    `[FACESWAP TRACE 3] Inputs — target(norm): ${Math.round(normalizedTargetBase64.length / 1024)}KB, swap(opt): ${Math.round(optimizedSwapBase64.length / 1024)}KB, declared mime: ${mimeType}`
  );
  console.log(`[FACESWAP VISUAL AUDIT - INPUTS]`);
  console.log(`  Target (Gemini): data:image/jpeg;base64,${normalizedTargetBase64.slice(0, 50)}...`);
  console.log(`  Swap (User face): data:image/jpeg;base64,${optimizedSwapBase64.slice(0, 50)}...`);

  const normalizedTargetDataUri = `data:image/jpeg;base64,${normalizedTargetBase64}`;
  const optimizedSwapDataUri = `data:image/jpeg;base64,${optimizedSwapBase64}`;
  const runAttempts: Array<{
    label: string;
    model: ReplicateModelRef;
    input: Record<string, string | number>;
  }> = [
    {
      label: "easel advanced-face-swap",
      model: PREMIUM_FACESWAP_MODEL,
      input: {
        target_image: normalizedTargetDataUri,
        swap_image: optimizedSwapDataUri,
        hair_source: "target",
      },
    },
    {
      label: "xiankgx target/source",
      model: FACESWAP_MODEL,
      input: {
        target_image: normalizedTargetDataUri,
        source_image: optimizedSwapDataUri,
        weight: IDENTITY_WEIGHT,
      },
    },
    {
      label: "xiankgx input/swap",
      model: FACESWAP_MODEL,
      input: {
        input_image: normalizedTargetDataUri,
        swap_image: optimizedSwapDataUri,
        weight: IDENTITY_WEIGHT,
      },
    },
    {
      label: "codeplugtech target/source",
      model: FALLBACK_FACESWAP_MODEL,
      input: {
        target_image: normalizedTargetDataUri,
        source_image: optimizedSwapDataUri,
      },
    },
    {
      label: "codeplugtech input/swap",
      model: FALLBACK_FACESWAP_MODEL,
      input: {
        input_image: normalizedTargetDataUri,
        swap_image: optimizedSwapDataUri,
      },
    },
  ];

  let outputUrl = "";
  let finalOutput: unknown = null;
  let lastError: unknown = null;
  const faceswapDeadline = Date.now() + FACESWAP_TOTAL_TIMEOUT_MS;

  for (const attempt of runAttempts) {
    const t0 = Date.now();
    const remainingMs = faceswapDeadline - Date.now();
    if (remainingMs <= 0) {
      lastError = new Error(`[FaceSwap] Total Stage 2 timeout exceeded after ${FACESWAP_TOTAL_TIMEOUT_MS}ms`);
      break;
    }
    console.log(`[FACESWAP TRACE 4] Calling replicate.run() via ${attempt.label}...`);
    console.log(`[FACESWAP VISUAL AUDIT - PARAMETERS]`);
    console.log(`  model: ${attempt.model}`);
    console.log(`  payload keys: ${Object.keys(attempt.input).join(", ")}`);
    console.log(`  timeout budget remaining: ${remainingMs}ms`);
    if ("weight" in attempt.input) {
      console.log(`  weight (identity): ${IDENTITY_WEIGHT}`);
    }
    console.log(`  face_enhancer: Disabled (preventing mannequin effect)`);

    try {
      const output = await withTimeout(
        replicate.run(attempt.model, { input: attempt.input }),
        remainingMs,
        `[FaceSwap] ${attempt.label}`
      );
      const elapsed = Date.now() - t0;
      console.log(`[FACESWAP TRACE 5] replicate.run() returned in ${elapsed}ms | type: ${typeof output} | value: ${String(output).slice(0, 120)}`);
      finalOutput = output;
      outputUrl = extractOutputUrl(output);

      if (outputUrl || (output && typeof output === "object" && "arrayBuffer" in output) || (Array.isArray(output) && output.length > 0)) {
        break;
      }

      lastError = new Error(`[FaceSwap] Replicate returned empty output. Raw: ${JSON.stringify(output)}`);
    } catch (error) {
      lastError = error;
      console.error(`[FACESWAP TRY FAILED] ${attempt.label}:`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`[FACESWAP VISUAL AUDIT - OUTPUT]`);
  console.log(`  Replicate result URL: ${outputUrl}`);
  console.log(`  (Open this URL in browser to see Stage 2 result - AFTER FaceSwap)`);

  if ((!outputUrl || outputUrl === "undefined" || outputUrl === "null") && !finalOutput) {
    throw lastError instanceof Error ? lastError : new Error(`[FaceSwap] Replicate returned empty output. Raw: ${String(lastError)}`);
  }

  const base64 = await downloadOutputAsBase64(finalOutput ?? outputUrl);

  console.log(`[FACESWAP TRACE 7] SUCCESS. Result size: ${Math.round(base64.length / 1024)}KB`);
  return base64;
}
