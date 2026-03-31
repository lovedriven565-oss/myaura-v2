import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { storage } from "./storage.js";
import { aiProvider } from "./ai.js";
import { buildPrompt, PromptType, StyleId } from "./prompts.js";

export const apiRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit per file

// 1. Upload & Start Generation (Supports single file for 'free' and multiple for 'premium')
apiRouter.post("/generate", upload.array("images", 15), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No images provided", code: "MISSING_IMAGE" });
    }

    const { type, preset } = req.body; // 'free' | 'premium', preset name (styleId)
    if (!type || !["free", "premium"].includes(type)) {
      return res.status(400).json({ error: "Invalid type. Must be 'free' or 'premium'", code: "INVALID_TYPE" });
    }

    if (type === "premium" && files.length < 10) {
      return res.status(400).json({ error: "Premium requires 10-15 images for reference", code: "INSUFFICIENT_IMAGES" });
    }

    if (type === "free" && files.length > 1) {
      return res.status(400).json({ error: "Free preview only accepts 1 image", code: "TOO_MANY_IMAGES" });
    }

    // Build strictly backend-controlled prompt
    const prompt = buildPrompt(type as PromptType, preset as StyleId);
    
    const id = uuidv4();
    const userId = req.headers["x-user-id"] || "anonymous";

    // Save originals
    const originalPaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = await storage.save(file.buffer, `${id}_${i}_${file.originalname}`, "original");
      originalPaths.push(path);
    }

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
        original_path: originalPaths[0], // Store first reference for legacy compat, consider standardizing to array in db
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
      // For MVP AI Provider, we use the first image as base reference (even for premium, until Vertex UI handles multiple)
      const baseFile = files[0];
      const base64Image = baseFile.buffer.toString("base64");
      const mimeType = baseFile.mimetype;
      
      const resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt);
      const resultBuffer = Buffer.from(resultBase64, "base64");
      const resultPath = await storage.save(resultBuffer, `${id}_result.jpg`, "result");

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
