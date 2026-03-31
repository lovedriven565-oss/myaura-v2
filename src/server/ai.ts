import { GoogleGenAI } from "@google/genai";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string): Promise<string>;
}

// Target Architecture: Vertex AI (GCP)
// Requires: GOOGLE_GENAI_USE_VERTEXAI="true", GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION
export class VertexAIProvider implements IGenerationProvider {
  private ai: GoogleGenAI;

  constructor() {
    // When GOOGLE_GENAI_USE_VERTEXAI=true is in env, the SDK automatically uses Vertex AI.
    // It relies on Application Default Credentials (ADC) or explicitly provided keys.
    // In a production server, ADC is the recommended way.
    this.ai = new GoogleGenAI({});
  }

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string): Promise<string> {
    try {
      // For MyAURA, which relies on strict likeness preservation and image-to-image transformation,
      // using a specialized image model is required rather than a generic text model.
      // We use `gemini-3-pro-image-preview` here in Vertex AI, which supports multimodal inputs 
      // natively optimized for generating and editing images while preserving context.
      const response = await this.ai.models.generateContent({
        model: "gemini-3-pro-image-preview", 
        contents: {
          parts: [
            {
              inlineData: {
                data: originalImageBase64,
                mimeType: mimeType,
              },
            },
            {
              text: prompt,
            },
          ],
        },
        config: {
          // Use standard image generation config matching the Gemini fallback
          imageConfig: {
            aspectRatio: "3:4",
            imageSize: "1K",
          },
        },
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data; // Base64 string
        }
      }

      throw new Error("No image data returned from Vertex AI model");
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

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string): Promise<string> {
    try {
      const response = await this.ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [
            {
              inlineData: {
                data: originalImageBase64,
                mimeType: mimeType,
              },
            },
            {
              text: prompt,
            },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: "3:4",
            imageSize: "1K",
          },
        },
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data; // Base64 string
        }
      }

      throw new Error("No image data returned from model");
    } catch (error: any) {
      console.error("AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image");
    }
  }
}

// Select provider based on config (use Gemini by default for MVP/dev)
const useVertex = process.env.USE_VERTEX_AI === "true";
export const aiProvider: IGenerationProvider = useVertex ? new VertexAIProvider() : new GeminiProvider();
