import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { storage } from "./storage.js";
import { aiProvider } from "./ai.js";
import { buildPrompt, StyleId } from "./prompts.js";
import { validatePackageInput, buildStyleSchedule, runBatched, getGenerationConfig } from "./packages.js";
import { deliverTelegramPhoto } from "./telegram.js";

export const apiRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit per file

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

// Validate file is a real image by checking magic bytes
function isValidImageBuffer(buf: Buffer, declaredMime: string): boolean {
  if (!ALLOWED_IMAGE_MIMES.has(declaredMime)) return false;
  if (buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return true;
  // HEIF/HEIC: ftyp at offset 4
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp") return true;
  return false;
}

// 1. Upload & Start Generation (Supports single file for 'free' and multiple for 'premium')
apiRouter.post("/generate", upload.array("images", 15), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No images provided", code: "MISSING_IMAGE" });
    }

    // Validate all uploaded files are real images
    for (const file of files) {
      if (!isValidImageBuffer(file.buffer, file.mimetype)) {
        return res.status(400).json({ 
          error: `Invalid image file: ${file.originalname}. Supported formats: JPEG, PNG, WebP, HEIC.`, 
          code: "INVALID_IMAGE" 
        });
      }
    }

    const { type, preset } = req.body; // legacy 'type' and 'preset'
    const packageId = req.body.packageId || type || "free";
    
    // Parse styleIds (could be JSON string array or a single string)
    let styleIds: string[] = [];
    if (req.body.styleIds) {
      try {
        styleIds = JSON.parse(req.body.styleIds);
      } catch (e) {
        styleIds = Array.isArray(req.body.styleIds) ? req.body.styleIds : [req.body.styleIds];
      }
    } else if (preset) {
      styleIds = [preset]; // legacy fallback
    }

    // Validate using packages logic
    const validation = validatePackageInput(packageId, files.length, styleIds);
    if (!validation.ok || !validation.config) {
      return res.status(400).json({ error: validation.error, code: validation.code });
    }
    const config = validation.config;
    
    const id = uuidv4();
    const userId = req.headers["x-user-id"] || "anonymous";

    // Save originals
    const originalPaths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = await storage.save(file.buffer, `${id}_${i}_${file.originalname}`, "original");
      originalPaths.push(path);
    }

    // Calculate expiration from package config
    const retentionMinutes = parseInt(process.env[config.retentionEnvKey] || config.retentionDefault.toString());
    const expiresAt = new Date(Date.now() + retentionMinutes * 60000).toISOString();

    const db = getDb();
    
    // Check if this was triggered from Telegram
    let telegramChatId: number | null = null;
    if (req.body.telegramChatId) {
      const parsed = parseInt(req.body.telegramChatId, 10);
      telegramChatId = isNaN(parsed) ? null : parsed;
    }

    const { error: insertError } = await db
      .from("generations")
      .insert({
        id,
        user_id: userId,
        type: config.promptTier, // Legacy compat
        package_id: packageId,
        status: "processing",
        original_path: originalPaths[0], // Legacy compat
        reference_paths: originalPaths,  // New array format
        prompt_preset: styleIds[0],      // Legacy compat
        style_ids: styleIds,             // New array format
        results_total: config.outputCount,
        results_completed: 0,
        expires_at: expiresAt,
        telegram_chat_id: telegramChatId
      });

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return next(new Error("Failed to create generation record"));
    }

    // Return immediately, process in background
    res.json({ id, status: "processing" });

    // Background processing
    try {
      const schedule = buildStyleSchedule(config, styleIds as StyleId[]);
      const genConfig = getGenerationConfig(config.id);
      console.log(`Generation ${id}: ${schedule.length} images, concurrency=${genConfig.concurrency}, delay=${genConfig.delayMs}ms`);

      // For MVP AI Provider, we use the first image as base reference
      const baseFile = files[0];
      const base64Image = baseFile.buffer.toString("base64");
      const mimeType = baseFile.mimetype;

      // Progressive state tracking
      let completedCount = 0;
      let failedCount = 0;
      const successPaths: string[] = [];
      const errors: string[] = [];
      let dbUpdateChain = Promise.resolve();

      // Task for generating a single image
      const generateOne = async (styleId: StyleId, index: number) => {
        const prompt = buildPrompt(config.promptTier, styleId);
        const resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt);
        const resultBuffer = Buffer.from(resultBase64, "base64");
        const resultPath = await storage.save(resultBuffer, `${id}_result_${index}.jpg`, "result");
        return resultPath;
      };

      // Progressive callback — fires after each image finishes (success or fail)
      const onItemComplete = (index: number, result: PromiseSettledResult<string>) => {
        if (result.status === "fulfilled") {
          completedCount++;
          successPaths.push(result.value);
          console.log(`Generation ${id}: image ${index + 1}/${schedule.length} completed (${completedCount} done)`);

          // Progressive Telegram delivery — send each photo immediately
          if (telegramChatId) {
            const caption = schedule.length === 1
              ? "Your portrait is ready!"
              : `Portrait ${completedCount} of ${schedule.length}`;
            deliverTelegramPhoto(telegramChatId, result.value, caption).catch(err => {
              console.error(`Progressive delivery failed for item ${index}:`, err);
            });
          }
        } else {
          failedCount++;
          errors.push(result.reason?.message || "Unknown error");
          console.warn(`Generation ${id}: image ${index + 1}/${schedule.length} failed: ${result.reason?.message}`);
        }

        // Chain DB updates sequentially to avoid race conditions
        dbUpdateChain = dbUpdateChain.then(() =>
          db.from("generations").update({
            results_completed: completedCount,
            results_failed: failedCount,
            result_path: successPaths[0] || null,
            result_paths: [...successPaths],
          }).eq("id", id)
        ).catch(err => console.error("Progressive DB update error:", err));
      };

      // Run generation with package-specific concurrency
      await runBatched(schedule, generateOne, {
        concurrency: genConfig.concurrency,
        delayMs: genConfig.delayMs,
        onItemComplete,
      });

      // Wait for any pending DB updates to flush
      await dbUpdateChain;

      // Determine final status
      // completed = all succeeded, partial = some succeeded, failed = none succeeded
      const finalStatus = completedCount === 0
        ? "failed"
        : completedCount < schedule.length ? "partial" : "completed";
      const finalErrorMsg = errors.length > 0 ? errors.join("; ") : null;

      await db
        .from("generations")
        .update({
          status: finalStatus,
          result_path: successPaths[0] || null,
          result_paths: successPaths,
          results_completed: completedCount,
          results_failed: failedCount,
          error_message: finalErrorMsg,
        })
        .eq("id", id);

      console.log(`Generation ${id} done: status=${finalStatus}, completed=${completedCount}, failed=${failedCount}`);

    } catch (genError: any) {
      console.error("Generation batch failed:", genError);
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
      .select("id, status, result_path, result_paths, results_completed, results_failed, results_total, error_message")
      .eq("id", id)
      .single();

    if (error || !row) {
      return res.status(404).json({ error: "Generation not found", code: "NOT_FOUND" });
    }

    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
    const resultUrl = row.result_path ? `${publicBaseUrl}/${row.result_path}` : null;
    const resultUrls = Array.isArray(row.result_paths) 
      ? row.result_paths.map((p: string) => `${publicBaseUrl}/${p}`) 
      : (resultUrl ? [resultUrl] : []);

    res.json({
      id: row.id,
      status: row.status,
      resultUrl, // Legacy compat
      resultUrls, // New array format
      progress: {
        completed: row.results_completed || 0,
        failed: row.results_failed || 0,
        total: row.results_total || 1,
      },
      error: row.error_message,
    });
  } catch (error) {
    next(error);
  }
});
