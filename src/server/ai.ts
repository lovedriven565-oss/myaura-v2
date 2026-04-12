import { GoogleGenAI } from "@google/genai";
import crypto from "crypto";
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
const BASE_DELAY_MS = 15000; // 15s base — Vertex AI quota resets per-minute
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

// Safety settings: minimize blocking for real face generation
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

// Target Architecture: Vertex AI (GCP) — location: global
// Requires: GOOGLE_GENAI_USE_VERTEXAI="true", GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION="global"
export class VertexAIProvider implements IGenerationProvider {
  private ai: GoogleGenAI;

  constructor() {
    // SDK reads GOOGLE_CLOUD_LOCATION from env; must be set to "global" for both image models
    this.ai = new GoogleGenAI({});
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
          // Low temperature = maximum fidelity to reference image (minimal creative deviation)
          temperature: mode === 'premium' ? 0.1 : 0.4,
          topP: mode === 'premium' ? 0.8 : 0.95,
        },
      } as any);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data;
        }
      }

      throw new Error(`No image data returned from Vertex AI model (${modelId})`);
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
