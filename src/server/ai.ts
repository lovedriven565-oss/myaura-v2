import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode?: 'preview' | 'premium', additionalImages?: string[]): Promise<string>;
}

// Dual-model segmentation:
// FREE tier  → gemini-3.1-flash-image-preview (Nano Banana 2), fallback: gemini-2.5-flash-image
// PREMIUM tier → gemini-3-pro-image-preview  (Nano Banana Pro), fallback: gemini-3.1-flash-image-preview
const FREE_MODEL_PRIMARY   = "gemini-3.1-flash-image-preview";
const FREE_MODEL_FALLBACK  = "gemini-2.5-flash-image";
const PRO_MODEL_PRIMARY    = "gemini-3-pro-image-preview";
const PRO_MODEL_FALLBACK   = "gemini-3.1-flash-image-preview";

// Retry configuration for resilience against 429 rate limits
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 15000; // 15s base
const MAX_DELAY_MS = 60000;  // cap at 60s

// Per-model call timeout: Pro model can take up to 120s, Flash up to 60s
const MODEL_CALL_TIMEOUT_MS: Record<string, number> = {
  ["gemini-3-pro-image-preview"]:    120_000,
  ["gemini-3.1-flash-image-preview"]: 90_000,
  ["gemini-2.5-flash-image"]:         60_000,
};
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

function stringifyErrorDetails(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

/**
 * Exponential backoff with jitter for resilient API calls
 * Formula: min(t_max, t_base * 2^attempt + random_jitter)
 */
async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      const isRateLimit = error?.status === 429 ||
                         error?.message?.includes("429") ||
                         error?.message?.includes("RESOURCE_EXHAUSTED") ||
                         error?.code === 429;
      // Key went to 24h cooldown (IAM/billing both models failed) — retry on next key immediately
      const isKeyExhausted = !!(error?.isKeyExhausted);

      if (isKeyExhausted && attempt < maxRetries) {
        console.warn(`[Retry] ${operationName} key exhausted. Switching key (attempt ${attempt + 1}/${maxRetries})...`);
        // No delay — getNextClient() will wait for cooldown if needed
        continue;
      }

      if (!isRateLimit || attempt >= maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter: min(t_max, t_base * 2^attempt + random_jitter)
      const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 1000); // 0-1000ms random jitter
      const delayMs = Math.min(MAX_DELAY_MS, exponentialDelay + jitter);

      console.warn(`[Retry] ${operationName} failed with 429. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`withExponentialBackoff: unreachable`);
}

// ─── Round-Robin Key Pool ───────────────────────────────────────────────────
// KeySlot no longer holds a long-lived client.
// A fresh GoogleGenAI instance with a disposable AbortController is created
// per-request so TCP connections are ACTUALLY closed on timeout/abort.

const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';

interface KeySlot {
  keyPath: string;
  projectId: string;   // cached at pool init, avoids repeated JSON reads
  keyHint: string;
  cooldownUntil: number;
}

const KEY_COOLDOWN_MS = 60_000; // cooldown 60s after a 429

function buildKeyPool(): KeySlot[] {
  const keysDir = path.resolve(process.cwd(), 'keys');
  console.log(`[KeyPool] Scanning ${keysDir}...`);

  if (!fs.existsSync(keysDir)) {
    console.warn("[KeyPool] keys folder does not exist — using ADC slot");
    return [{ keyPath: "", projectId: "", keyHint: "adc", cooldownUntil: 0 }];
  }

  const files = fs.readdirSync(keysDir);
  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'dummy.json');

  if (jsonFiles.length === 0) {
    console.warn("[KeyPool] No JSON keys found — using ADC slot");
    return [{ keyPath: "", projectId: "", keyHint: "adc", cooldownUntil: 0 }];
  }

  console.log(`[KeyPool] Found ${jsonFiles.length} JSON key(s) in ./keys`);

  return jsonFiles.map(filename => {
    const keyPath = path.join(keysDir, filename);
    const keyContent = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    const projectId = keyContent.project_id || 'unknown';
    return { keyPath, projectId, keyHint: filename.slice(-6), cooldownUntil: 0 };
  });
}

/**
 * Creates a fresh GoogleGenAI client bound to a disposable AbortController.
 * Returns both the client and a cleanup function that aborts and closes TCP.
 */
function createEphemeralClient(slot: KeySlot, signal: AbortSignal): GoogleGenAI {
  const opts: Record<string, any> = {
    httpOptions: { signal },
  };

  if (slot.keyPath) {
    // Temporarily set GOOGLE_APPLICATION_CREDENTIALS for this client init
    const prev = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = slot.keyPath;
    Object.assign(opts, { vertexai: true, project: slot.projectId, location: VERTEX_LOCATION });
    const client = new GoogleGenAI(opts);
    if (prev !== undefined) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = prev;
    } else {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    return client;
  }

  // ADC fallback (no key file)
  return new GoogleGenAI(opts);
}

const keyPool: KeySlot[] = buildKeyPool();
let keyIndex = 0;

async function getNextClient(): Promise<KeySlot> {
  const now = Date.now();
  const total = keyPool.length;

  for (let i = 0; i < total; i++) {
    const slot = keyPool[(keyIndex + i) % total];
    if (slot.cooldownUntil <= now) {
      keyIndex = ((keyIndex + i) + 1) % total;
      return slot;
    }
  }

  // All keys in cooldown — wait for the earliest to become ready
  const earliest = keyPool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b);
  const waitMs = earliest.cooldownUntil - now;
  const waitSec = Math.ceil(waitMs / 1000);
  console.warn(`[KeyPool] All ${total} key(s) cooling. Waiting ${waitSec}s for key ...${earliest.keyHint}`);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  keyIndex = (keyPool.findIndex(s => s === earliest) + 1) % total;
  return earliest;
}

function markKeyCooldown(slot: KeySlot): void {
  slot.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  const ready = keyPool.filter(k => k.cooldownUntil <= Date.now()).length;
  console.warn(`[KeyPool] Key ...${slot.keyHint} → cooldown 60s | ${ready}/${keyPool.length} key(s) still ready`);
}

/**
 * Classifies an error from Vertex AI into actionable categories.
 */
function classifyError(err: any, errMsg: string, errDetails: any[], errBlob: string): {
  isBilling: boolean;
  isModelPermission: boolean;
  is429: boolean;
} {
  let parsedError: any = null;
  try { parsedError = JSON.parse(errMsg); } catch {}

  const isBilling =
    /billing|project_disabled|account_disabled|enable billing/i.test(errBlob) ||
    errDetails.some((d: any) => d?.reason === "BILLING_DISABLED") ||
    (parsedError?.error?.details?.some?.((d: any) => d?.reason === "BILLING_DISABLED")) ||
    (err?.error?.details?.some?.((d: any) => d?.reason === "BILLING_DISABLED"));

  const isModelPermission = !isBilling && (
    /iam_permission_denied|permission_denied/i.test(errBlob) ||
    err?.status === 403 ||
    err?.status === "PERMISSION_DENIED" ||
    err?.error?.code === 403 ||
    parsedError?.error?.code === 403 ||
    errDetails.some((d: any) => d?.reason === "IAM_PERMISSION_DENIED") ||
    (parsedError?.error?.details?.some?.((d: any) => d?.reason === "IAM_PERMISSION_DENIED")) ||
    (err?.error?.details?.some?.((d: any) => d?.reason === "IAM_PERMISSION_DENIED"))
  );

  const is429 = err?.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED");

  return { isBilling, isModelPermission, is429 };
}

// Safety settings: minimize blocking for real face generation
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

export class VertexAIProvider implements IGenerationProvider {

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium' = 'premium', additionalImages?: string[]): Promise<string> {
    const operation = async () => {
      const slot = await getNextClient();
      const ready = keyPool.filter(k => k.cooldownUntil <= Date.now()).length;
      console.log(`[KeyPool] Using key ...${slot.keyHint} | ${ready}/${keyPool.length} ready`);
      return this._generate(slot, originalImageBase64, mimeType, prompt, mode, additionalImages);
    };

    try {
      return await withExponentialBackoff(operation, "VertexAI.generateImage");
    } catch (error: any) {
      console.error("Vertex AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image via Vertex AI");
    }
  }

  private async _callModel(slot: KeySlot, modelId: string, contents: any[], mode: 'preview' | 'premium'): Promise<string> {
    const timeoutMs = MODEL_CALL_TIMEOUT_MS[modelId] ?? DEFAULT_CALL_TIMEOUT_MS;
    const timeoutSec = Math.round(timeoutMs / 1000);

    // Disposable AbortController: abort() actually closes the underlying TCP
    // socket because the signal is wired into the GoogleGenAI client at
    // construction time (httpOptions.signal). This is the only reliable way
    // to prevent dangling connections with @google/genai SDK.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const client = createEphemeralClient(slot, controller.signal);

      const response = await client.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore
          responseModalities: ["TEXT", "IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature: mode === 'premium' ? 0.2 : 0.4,
          topP: mode === 'premium' ? 0.9 : 0.95,
        },
      } as any);

      clearTimeout(timeoutId);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data!;
        }
      }
      throw new Error(`No image data returned from ${modelId}`);

    } catch (err: any) {
      clearTimeout(timeoutId);
      // AbortError = our timeout fired — translate to a recognisable isTimeout error
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        throw Object.assign(
          new Error(`[TIMEOUT] ${modelId} did not respond in ${timeoutSec}s`),
          { isTimeout: true }
        );
      }
      throw err;
    }
  }

  private async _generate(slot: KeySlot, originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium', additionalImages?: string[]): Promise<string> {
    const tier = mode === 'premium' ? 'PREMIUM' : 'FREE';
    const primaryModel  = mode === 'premium' ? PRO_MODEL_PRIMARY  : FREE_MODEL_PRIMARY;
    const fallbackModel = mode === 'premium' ? PRO_MODEL_FALLBACK : FREE_MODEL_FALLBACK;

    const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
    const contents: any[] = [];
    contents.push({ inlineData: { data: originalImageBase64, mimeType } });
    // Defense-in-depth: only pass additional refs when explicitly expected
    // Premium: always. Free: only when FREE_V2 is enabled.
    if (additionalImages && additionalImages.length > 0 && (mode === 'premium' || FREE_V2)) {
      for (const img of additionalImages) {
        contents.push({ inlineData: { data: img, mimeType } });
      }
    }
    contents.push({ text: prompt });

    console.log(`[Stage1] [Tier: ${tier}] Trying ${primaryModel} (global) | key ...${slot.keyHint}`);

    try {
      const result = await this._callModel(slot, primaryModel, contents, mode);
      console.log(`[Stage1] SUCCESS | [Tier: ${tier}] model=${primaryModel} | key ...${slot.keyHint} | preview: ${result.slice(0, 50)}...`);
      return result;
    } catch (err: any) {
      const errMsg: string = err?.message || "";
      const errDetails = err?.details || [];
      const errBlob = [errMsg, stringifyErrorDetails(errDetails), stringifyErrorDetails(err?.error), stringifyErrorDetails(err)].join(" ");
      const { isBilling, isModelPermission, is429 } = classifyError(err, errMsg, errDetails, errBlob);
      const isTimeout = !!(err?.isTimeout);
      const isFetchFailed = errMsg.includes("fetch failed") || errMsg.includes("ECONNRESET") || errMsg.includes("ECONNREFUSED");

      if (isBilling) {
        console.error(`[BILLING ERROR] Key ...${slot.keyHint} → 24h cooldown`);
        slot.cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
        throw err;
      } else if (is429) {
        markKeyCooldown(slot);
        throw err;
      } else if (isModelPermission) {
        console.warn(`[IAM] Key ...${slot.keyHint}: ${primaryModel} denied → trying fallback ${fallbackModel}`);
      } else if (isTimeout) {
        console.warn(`[TIMEOUT] Key ...${slot.keyHint}: ${primaryModel} timed out → trying fallback ${fallbackModel}`);
      } else if (isFetchFailed) {
        console.warn(`[NET] Key ...${slot.keyHint}: ${primaryModel} fetch failed → trying fallback ${fallbackModel}`);
      } else {
        console.warn(`[Stage1] [Tier: ${tier}] Primary error (${primaryModel}): ${errMsg.slice(0, 120)} → trying fallback ${fallbackModel}`);
      }

      // Fallback attempt
      console.log(`[Stage1] [Tier: ${tier}] Fallback → ${fallbackModel} | key ...${slot.keyHint}`);
      try {
        const result = await this._callModel(slot, fallbackModel, contents, mode);
        console.log(`[Stage1] FALLBACK SUCCESS | [Tier: ${tier}] model=${fallbackModel} | key ...${slot.keyHint}`);
        return result;
      } catch (fallbackErr: any) {
        const fbMsg: string = fallbackErr?.message || "";
        const fbBlob = [fbMsg, stringifyErrorDetails(fallbackErr?.error), stringifyErrorDetails(fallbackErr)].join(" ");
        const fb = classifyError(fallbackErr, fbMsg, fallbackErr?.details || [], fbBlob);
        if (fb.isBilling) {
          console.error(`[BILLING ERROR] Key ...${slot.keyHint} (fallback) → 24h cooldown`);
          slot.cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
        } else if (fb.isModelPermission) {
          console.error(`[IAM ERROR] Key ...${slot.keyHint}: both ${primaryModel} and ${fallbackModel} denied → 24h cooldown (key unusable)`);
          slot.cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
          throw Object.assign(fallbackErr, { isKeyExhausted: true });
        } else if (fb.is429) {
          markKeyCooldown(slot);
        }
        console.error(`[Stage1] FALLBACK FAILED | [Tier: ${tier}] model=${fallbackModel} | ${fbMsg.slice(0, 120)}`);
        throw fallbackErr;
      }
    }
  }
}

export class GeminiProvider implements IGenerationProvider {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium' = 'premium', additionalImages?: string[]): Promise<string> {
    const operation = async () => {
      const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
      const contents: any[] = [];
      contents.push({ inlineData: { data: originalImageBase64, mimeType } });
      // Defense-in-depth: only pass additional refs when explicitly expected
      if (additionalImages && additionalImages.length > 0 && (mode === 'premium' || FREE_V2)) {
        for (const img of additionalImages) {
          contents.push({ inlineData: { data: img, mimeType } });
        }
      }
      contents.push({ text: prompt });

      const modelId = mode === 'premium' ? PRO_MODEL_PRIMARY : FREE_MODEL_PRIMARY;
      const response = await this.ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore
          responseModalities: ["TEXT", "IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature: mode === 'premium' ? 0.2 : 0.4,
          topP: mode === 'premium' ? 0.9 : 0.95,
        },
      } as any);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) return part.inlineData.data;
      }
      throw new Error(`No image data returned from model (${modelId})`);
    };

    try {
      return await withExponentialBackoff(operation, "Gemini.generateImage");
    } catch (error: any) {
      console.error("AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image");
    }
  }
}

const useVertex = process.env.USE_VERTEX_AI === "true";
export const aiProvider: IGenerationProvider = useVertex ? new VertexAIProvider() : new GeminiProvider();
