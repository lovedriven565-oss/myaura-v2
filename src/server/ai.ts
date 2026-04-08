import { GoogleGenAI } from "@google/genai";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode?: 'preview' | 'premium', additionalImages?: string[]): Promise<string>;
}

// Dual-model routing: free preview uses flash (fast), premium uses pro (quality)
// Both are confirmed Vertex AI models with image output support on location: global
const FREE_MODEL_ID = "gemini-2.5-flash-image";       // Vertex AI, global, Public preview
const PREMIUM_MODEL_ID = "gemini-3-pro-image-preview"; // Vertex AI, global, Public preview

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
    try {
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
        },
      } as any);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data;
        }
      }

      throw new Error(`No image data returned from Vertex AI model (${modelId})`);
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
    try {
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
        },
      } as any);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data;
        }
      }

      throw new Error(`No image data returned from model (${modelId})`);
    } catch (error: any) {
      console.error("AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image");
    }
  }
}

// Select provider based on config (use Gemini by default for MVP/dev)
const useVertex = process.env.USE_VERTEX_AI === "true";
export const aiProvider: IGenerationProvider = useVertex ? new VertexAIProvider() : new GeminiProvider();
