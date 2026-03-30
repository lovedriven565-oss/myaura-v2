import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { storage } from "./storage.js";
import { aiProvider } from "./ai.js";

export const apiRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// Presets
const PRESETS: Record<string, string> = {
  business: "Create a professional business headshot, high-end studio lighting, sharp suit, confident expression, neutral background.",
  studio: "Create a high-fashion studio editorial portrait, dramatic lighting, stylish outfit, vogue magazine style.",
  nature: "Create an outdoor natural lighting portrait lifestyle, soft sunlight, blurred nature background, relaxed and approachable.",
};

// 1. Upload & Start Generation
apiRouter.post("/generate", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image provided", code: "MISSING_IMAGE" });
    }

    const { type, preset } = req.body; // 'free' | 'premium', preset name
    if (!type || !["free", "premium"].includes(type)) {
      return res.status(400).json({ error: "Invalid type", code: "INVALID_TYPE" });
    }

    const prompt = PRESETS[preset] || PRESETS["business"];
    const id = uuidv4();
    const userId = req.headers["x-user-id"] || "anonymous";

    // Save original
    const originalPath = await storage.save(req.file.buffer, req.file.originalname, "original");

    // Calculate expiration
    const retentionMinutes = type === "premium" 
      ? parseInt(process.env.RETENTION_PREMIUM_REF_MINUTES || "4320") 
      : parseInt(process.env.RETENTION_ORIGINAL_MINUTES || "1440");
    
    const expiresAt = new Date(Date.now() + retentionMinutes * 60000).toISOString();

    const db = getDb();
    
    const { error: insertError } = await db
      .from("generations")
      .insert({
        id,
        user_id: userId,
        type,
        status: "processing",
        original_path: originalPath,
        prompt_preset: preset,
        expires_at: expiresAt
      });

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return next(new Error("Failed to create generation record"));
    }

    // Return immediately, process in background
    res.json({ id, status: "processing" });

    // Background processing
    try {
      const base64Image = req.file!.buffer.toString("base64");
      const mimeType = req.file!.mimetype;
      
      const resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt);
      const resultBuffer = Buffer.from(resultBase64, "base64");
      const resultPath = await storage.save(resultBuffer, "result.jpg", "result");

      await db
        .from("generations")
        .update({ status: "completed", result_path: resultPath })
        .eq("id", id);
        
    } catch (genError: any) {
      console.error("Generation failed:", genError);
      await db
        .from("generations")
        .update({ status: "failed", error_message: genError.message })
        .eq("id", id);
    }
  } catch (error) {
    next(error);
  }
});

// 2. Check Status
apiRouter.get("/status/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const { data: row, error } = await db
      .from("generations")
      .select("id, status, result_path, error_message")
      .eq("id", id)
      .single();

    if (error || !row) {
      return res.status(404).json({ error: "Generation not found", code: "NOT_FOUND" });
    }

    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
    const resultUrl = row.result_path ? `${publicBaseUrl}/${row.result_path}` : null;

    res.json({
      id: row.id,
      status: row.status,
      resultUrl,
      error: row.error_message,
    });
  } catch (error) {
    next(error);
  }
});
