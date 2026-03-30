import { GoogleGenAI } from "@google/genai";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string): Promise<string>;
}

export class VertexAIProvider implements IGenerationProvider {
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
      console.error("Vertex AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image");
    }
  }
}

export const aiProvider = new VertexAIProvider();
