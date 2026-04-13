import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { swapFace } from "./faceswap.js";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode?: 'preview' | 'premium', additionalImages?: string[]): Promise<string>;
}

// Dual-model routing: free preview uses flash (fast), premium uses pro (quality)
// Both are confirmed Vertex AI models with image output support on location: global
const FREE_MODEL_ID = "gemini-2.5-flash-image";       // Vertex AI, global, Public preview
const PREMIUM_MODEL_ID = "gemini-3-pro-image-preview"; // Vertex AI, global, Public preview

// Retry configuration for resilience against 429 rate limits
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 30000; // 30s base — aggressive backoff for Vertex AI quota
const MAX_DELAY_MS = 90000; // cap at 90s

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
// Supports VERTEX_API_KEYS=key1,key2,key3 (comma-separated).
// Falls back to single ADC client if no keys defined.

interface KeySlot {
  client: GoogleGenAI;
  keyPath: string;      // full path to JSON file for GOOGLE_APPLICATION_CREDENTIALS
  keyHint: string;      // filename for logging
  cooldownUntil: number; // epoch ms — 0 means ready
}

const KEY_COOLDOWN_MS = 60_000; // cooldown 60s after a 429

function buildKeyPool(): KeySlot[] {
  const keysDir = path.resolve(process.cwd(), 'keys');
  console.log(`[KeyPool] Scanning ${keysDir}...`);

  if (!fs.existsSync(keysDir)) {
    console.warn("[KeyPool] keys folder does not exist — using single ADC client");
    return [{ client: new GoogleGenAI({}), keyPath: "", keyHint: "adc", cooldownUntil: 0 }];
  }

  const files = fs.readdirSync(keysDir);
  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'dummy.json');

  if (jsonFiles.length === 0) {
    console.warn("[KeyPool] No JSON keys found (excluding dummy.json) — using single ADC client");
    return [{ client: new GoogleGenAI({}), keyPath: "", keyHint: "adc", cooldownUntil: 0 }];
  }

  console.log(`[KeyPool] Found ${jsonFiles.length} JSON key(s) in ./keys`);

  return jsonFiles.map(filename => {
    const keyPath = path.join(keysDir, filename);
    // Parse JSON to extract project_id for Vertex AI
    const keyContent = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    const projectId = keyContent.project_id || 'unknown';

    // Temporarily set GOOGLE_APPLICATION_CREDENTIALS for client init
    const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    const client = new GoogleGenAI({ vertexai: true, project: projectId, location: 'global' });
    if (prevCreds !== undefined) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
    } else {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }

    return {
      client,
      keyPath,
      keyHint: filename.slice(-6),
      cooldownUntil: 0,
    };
  });
}

const keyPool: KeySlot[] = buildKeyPool();
let keyIndex = 0;

function getNextClient(): KeySlot {
  const now = Date.now();
  const total = keyPool.length;

  for (let i = 0; i < total; i++) {
    const slot = keyPool[(keyIndex + i) % total];
    if (slot.cooldownUntil <= now) {
      keyIndex = ((keyIndex + i) + 1) % total;
      return slot;
    }
  }

  // All keys in cooldown — return the one expiring soonest
  const earliest = keyPool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b);
  const waitSec = Math.ceil((earliest.cooldownUntil - now) / 1000);
  console.warn(`[KeyPool] All ${total} key(s) cooling. Soonest ready in ${waitSec}s (key ...${earliest.keyHint})`);
  return earliest;
}

function markKeyCooldown(slot: KeySlot): void {
  slot.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  const ready = keyPool.filter(k => k.cooldownUntil <= Date.now()).length;
  console.warn(`[KeyPool] Key ...${slot.keyHint} → cooldown 60s | ${ready}/${keyPool.length} key(s) still ready`);
}

// Safety settings: minimize blocking for real face generation
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

// Target Architecture: Vertex AI (GCP) — location: global
// Requires: GOOGLE_GENAI_USE_VERTEXAI="true", GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION="global"
// Key rotation: set VERTEX_API_KEYS=key1,key2,... for multi-project round-robin
export class VertexAIProvider implements IGenerationProvider {

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium' = 'premium', additionalImages?: string[]): Promise<string> {
    // Each invocation picks the next available (non-cooling) key
    const operation = async () => {
      const slot = getNextClient();
      const ready = keyPool.filter(k => k.cooldownUntil <= Date.now()).length;
      console.log(`[KeyPool] Using key ...${slot.keyHint} | ${ready}/${keyPool.length} ready`);

      // Build contents array: images first, prompt last
      const contents: any[] = [];

      contents.push({ inlineData: { data: originalImageBase64, mimeType } });

      if (mode === 'premium' && additionalImages && additionalImages.length > 0) {
        for (const imgBase64 of additionalImages) {
          contents.push({ inlineData: { data: imgBase64, mimeType } });
        }
      }

      contents.push({ text: prompt });

      const modelId = mode === 'premium' ? PREMIUM_MODEL_ID : FREE_MODEL_ID;

      try {
        const response = await slot.client.models.generateContent({
          model: modelId,
          contents,
          config: {
            // @ts-ignore — SDK types lag behind REST API; these params ARE supported
            responseModalities: ["TEXT", "IMAGE"],
            safetySettings: SAFETY_SETTINGS,
            temperature: mode === 'premium' ? 0.1 : 0.4,
            topP: mode === 'premium' ? 0.8 : 0.95,
          },
        } as any);

        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) return part.inlineData.data;
        }
        throw new Error(`No image data returned from Vertex AI model (${modelId})`);

      } catch (err: any) {
        const errMsg: string = err?.message || "";
        const errDetails = err?.details || [];

        // Parse err.message as JSON if it's a stringified error object
        let parsedError: any = null;
        try {
          parsedError = JSON.parse(errMsg);
        } catch {
          // Not JSON, use as-is
        }

        // Check for billing errors in multiple places: message string, details array, nested error object
        const isBilling = errMsg.includes("billing") || errMsg.includes("BILLING") ||
                          errMsg.includes("PROJECT_DISABLED") || errMsg.includes("billing not enabled") ||
                          errMsg.includes("enable billing") || errMsg.includes("ACCOUNT_DISABLED") ||
                          errMsg.includes("IAM_PERMISSION_DENIED") || errMsg.includes("PERMISSION_DENIED") ||
                          err?.status === "PERMISSION_DENIED" ||
                          err?.error?.status === "PERMISSION_DENIED" ||
                          (parsedError?.error?.status === "PERMISSION_DENIED") ||
                          (parsedError?.error?.details && parsedError.error.details.some((d: any) => d?.reason === "IAM_PERMISSION_DENIED")) ||
                          errDetails.some((d: any) => d?.reason === "BILLING_DISABLED" || d?.reason === "IAM_PERMISSION_DENIED") ||
                          (err?.error?.message && (err.error.message.includes("billing") || err.error.message.includes("permission"))) ||
                          (err?.error?.details && err.error.details.some((d: any) => d?.reason === "BILLING_DISABLED" || d?.reason === "IAM_PERMISSION_DENIED"));

        const is429 = err?.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED");

        if (isBilling) {
          // Billing error = permanent failure for this key in this process lifetime.
          // Set cooldown to 24 hours so the key is never retried.
          console.error("╔══════════════════════════════════════════════════════════════════╗");
          console.error(`║  [GCP BILLING ERROR] Key ${slot.keyHint} has no billing enabled or permission denied! ║`);
          console.error(`║  This key will be SKIPPED for the next 24 hours.               ║`);
          console.error("╚══════════════════════════════════════════════════════════════════╝");
          console.error("[GCP Billing Error message]:", errMsg.slice(0, 300));
          console.error("[GCP Billing Error details]:", JSON.stringify(errDetails, null, 2));
          slot.cooldownUntil = Date.now() + 24 * 60 * 60 * 1000; // 24h — effectively permanent
        }

        if (is429) {
          console.error("╔══════════════════════════════════════════════════════════════════╗");
          console.error(`║  [GCP 429] RESOURCE_EXHAUSTED on key: ${slot.keyHint}            ║`);
          console.error("╚══════════════════════════════════════════════════════════════════╝");
          console.error("[GCP Deep Error]:", JSON.stringify({ status: err?.status, message: errMsg, details: err?.details }, null, 2));
          markKeyCooldown(slot);
        }

        throw err;
      }
    };

    try {
      const geminiBase64 = await withExponentialBackoff(operation, "VertexAI.generateImage");

      // Stage 2: FaceSwap — paste user's real face onto Gemini-generated base
      const replicateToken = process.env.REPLICATE_API_TOKEN;
      console.log("[TwoStep] REPLICATE_API_TOKEN present:", !!replicateToken, "| length:", replicateToken?.length ?? 0);

      if (replicateToken) {
        try {
          console.log("[TwoStep] Stage 2: Starting FaceSwap via Replicate...");
          const swapped = await swapFace(geminiBase64, originalImageBase64, mimeType);
          console.log("[TwoStep] Stage 2: FaceSwap SUCCESS");
          return swapped;
        } catch (swapErr: any) {
          console.error("╔══════════════════════════════════════════════════════╗");
          console.error("║  [FACESWAP ERROR] Stage 2 FAILED — using Gemini base ║");
          console.error("╚══════════════════════════════════════════════════════╝");
          console.error("[FACESWAP ERROR] Message:", swapErr.message);
          console.error("[FACESWAP ERROR] Stack:", swapErr.stack);
          return geminiBase64;
        }
      } else {
        console.warn("[TwoStep] REPLICATE_API_TOKEN is empty/unset — Stage 2 SKIPPED, returning Gemini base");
      }

      return geminiBase64;
    } catch (error: any) {
      console.error("Vertex AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image via Vertex AI");
    }
  }
}

// Fallback/Dev Architecture: Gemini Developer API
export class GeminiProvider implements IGenerationProvider {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium' = 'premium', additionalImages?: string[]): Promise<string> {
    const operation = async () => {
      // Build contents array: images first, prompt last
      const contents: any[] = [];

      // Add primary image
      contents.push({
        inlineData: { data: originalImageBase64, mimeType },
      });

      // For premium mode, add all additional reference images for character consistency
      if (mode === 'premium' && additionalImages && additionalImages.length > 0) {
        for (const imgBase64 of additionalImages) {
          contents.push({
            inlineData: { data: imgBase64, mimeType },
          });
        }
      }

      // Prompt goes last
      contents.push({ text: prompt });

      const modelId = mode === 'premium' ? PREMIUM_MODEL_ID : FREE_MODEL_ID;
      const response = await this.ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore — SDK types lag behind REST API; these params ARE supported
          responseModalities: ["TEXT", "IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature: mode === 'premium' ? 0.1 : 0.4,
          topP: mode === 'premium' ? 0.8 : 0.95,
        },
      } as any);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data;
        }
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

// Select provider based on config (use Gemini by default for MVP/dev)
const useVertex = process.env.USE_VERTEX_AI === "true";
export const aiProvider: IGenerationProvider = useVertex ? new VertexAIProvider() : new GeminiProvider();
