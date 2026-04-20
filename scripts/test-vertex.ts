import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

if (process.env.GOOGLE_APPLICATION_CREDENTIALS === "/var/www/myaura-v2/gcp-service-account.json") {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

const project = "myaura-production-492012";
const locations = ["us-central1"];
const modelsToTest = [
  "gemini-3.1-flash-image-preview",
  "gemini-2.5-flash-image",
  "gemini-1.5-flash-001",
];

const apiVersions = ["v1", "v1beta1"];

async function main() {
  for (const location of locations) {
    console.log(`\n=========================================`);
    console.log(`Testing Region: ${location}`);
    console.log(`=========================================`);
    
    for (const apiVersion of apiVersions) {
      console.log(`\n--- API Version: ${apiVersion} ---`);
      
      const genAI: any = new GoogleGenAI({
        vertexai: true,
        project: project,
        location: location,
        apiVersion: apiVersion,
      });

      for (const modelId of modelsToTest) {
        console.log(`\n[v3.3-DIAG] Testing model: ${modelId}...`);
        try {
          const response = await genAI.models.generateContent({
            model: modelId,
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
          });
          console.log(`[v3.3-DIAG] SUCCESS for ${modelId} (${apiVersion}):`, JSON.stringify(response.candidates?.[0]?.content?.parts));
        } catch (err: any) {
          console.error(`[v3.3-DIAG] FAILED for ${modelId} (${apiVersion}):`);
          try {
            const parsed = JSON.parse(err.message);
            console.error(" - Reason:", parsed.error.status);
            console.error(" - Message:", parsed.error.message);
          } catch (e) {
            console.error(" - Message:", err.message);
          }
        }
      }
    }
  }
}

main();

main();
