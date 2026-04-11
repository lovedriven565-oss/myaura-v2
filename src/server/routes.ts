import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { storage } from "./storage.js";
import { aiProvider } from "./ai.js";
import { buildPrompt, StyleId } from "./prompts.js";
import { validatePackageInput, buildStyleSchedule, buildStyleScheduleWithCount, runBatched, getGenerationConfig, PACKAGES } from "./packages.js";
import { deliverTelegramPhoto, deliverTelegramResults } from "./telegram.js";
import { selectBestReferencePhotos } from "./inputCuration.js";
import { evaluateGeneratedPhoto, clearRerollTracking } from "./qualityGate.js";
import crypto from "crypto";

export const apiRouter = Router();

// ─── Telegram initData Validation (Security) ─────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const INIT_DATA_MAX_AGE_SECONDS = 86400; // 24 hours — Telegram refreshes initData per session launch

/**
 * Validates Telegram Mini App initData using HMAC-SHA256
 * Verifies signature and checks auth_date freshness (anti-replay)
 * Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns detailed debug info for troubleshooting
 */
function validateInitData(initData: string): {
  valid: boolean;
  telegramId?: number;
  error?: string;
  debug?: { receivedHash: string; calculatedHash: string; dataCheckString: string };
} {
  if (!initData || !BOT_TOKEN) {
    return { valid: false, error: "Missing initData or BOT_TOKEN" };
  }

  try {
    // Parse initData manually to preserve URL-encoding (URLSearchParams decodes values)
    const params: Record<string, string> = {};
    const pairs = initData.split("&");
    let hash: string | null = null;

    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;

      const key = pair.substring(0, eqIndex);
      const value = pair.substring(eqIndex + 1); // Keep raw URL-encoded value

      if (key === "hash") {
        hash = value;
      } else {
        params[key] = value;
      }
    }

    if (!hash) {
      return { valid: false, error: "Missing hash in initData" };
    }

    // Check auth_date freshness (anti-replay protection)
    const authDate = params["auth_date"];
    if (authDate) {
      const now = Math.floor(Date.now() / 1000);
      const authTimestamp = parseInt(authDate, 10);
      const age = now - authTimestamp;

      if (age > INIT_DATA_MAX_AGE_SECONDS || age < -60) {
        return { valid: false, error: `initData expired or invalid (age=${age}s, max=${INIT_DATA_MAX_AGE_SECONDS}s)` };
      }
    } else {
      return { valid: false, error: "Missing auth_date in initData" };
    }

    // Build data_check_string by sorting keys alphabetically, joining with \n
    // Per Telegram spec: keys sorted alphabetically, format: key1=value1\nkey2=value2
    const sortedKeys = Object.keys(params).sort();
    const dataCheckString = sortedKeys.map(key => `${key}=${params[key]}`).join("\n");

    // Create secret key: HMAC-SHA256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    // Calculate signature: HMAC-SHA256(secret_key, data_check_string)
    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    // Debug logging for troubleshooting
    const debug = { receivedHash: hash, calculatedHash, dataCheckString };

    // Compare signatures (constant-time comparison not critical here, but good practice)
    if (calculatedHash !== hash) {
      return { valid: false, error: "Invalid initData signature", debug };
    }

    // Extract user data if needed
    const userJson = params["user"];
    let telegramId: number | undefined;
    if (userJson) {
      try {
        const user = JSON.parse(decodeURIComponent(userJson));
        telegramId = user.id;
      } catch {
        // Non-critical: validation passed but couldn't parse user
      }
    }

    return { valid: true, telegramId };
  } catch (err: any) {
    return { valid: false, error: `Validation error: ${err.message}` };
  }
}

/**
 * Express middleware to validate Telegram initData from request body/header
 * Includes detailed logging and bypass mode for debugging
 */
function initDataAuthMiddleware(req: any, res: any, next: any) {
  // Accept initData from body (POST requests) or x-init-data header (sent by frontend)
  const initData = req.body?.initData
    || req.headers["x-init-data"]
    || req.headers["X-Init-Data"]
    || req.headers["x-telegram-init-data"]
    || req.headers["X-Telegram-Init-Data"];

  const isStrict = process.env.INIT_DATA_STRICT === "true";

  if (!initData) {
    console.log(`[Auth] No initData received. INIT_DATA_STRICT=${isStrict}`);
    // Allow requests without initData for non-Telegram clients (dev/testing)
    if (isStrict) {
      return res.status(401).json({ error: "Missing initData authentication" });
    }
    console.log("[Auth] No initData, passing through (strict=false)");
    return next();
  }

  const validation = validateInitData(initData);

  if (!validation.valid) {
    console.warn(`[Auth] Invalid initData: ${validation.error}`);

    // Debug logging: show hashes for troubleshooting
    if (validation.debug) {
      console.log("[Auth Debug] Received hash:", validation.debug.receivedHash);
      console.log("[Auth Debug] Calculated hash:", validation.debug.calculatedHash);
      console.log("[Auth Debug] Data check string:", validation.debug.dataCheckString);
    }

    // BYPASS MODE: if strict=false, log warning but allow request through
    if (!isStrict) {
      console.warn("[Auth] WARNING: Invalid auth, but passing due to INIT_DATA_STRICT=false");
      return next();
    }

    return res.status(401).json({ error: "Invalid authentication", details: validation.error });
  }

  // Attach validated telegramId to request for downstream use
  if (validation.telegramId) {
    req.telegramId = validation.telegramId;
    console.log(`[Auth] Valid initData for telegramId: ${validation.telegramId}`);
  } else {
    console.log("[Auth] Valid initData but no telegramId extracted");
  }

  next();
}

// Apply initData auth middleware to all API routes
apiRouter.use(initDataAuthMiddleware);

// ─── Per-user Generation Rate Limiter ────────────────────────────────────────
const _genRateMap = new Map<number, number>(); // userId → last generation timestamp (ms)
const GENERATION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes per user

function generationRateLimitMiddleware(req: any, res: any, next: any) {
  const telegramUserId = parseInt(req.body?.telegramUserId, 10);
  if (!telegramUserId || isNaN(telegramUserId)) return next();

  const now = Date.now();
  const lastGen = _genRateMap.get(telegramUserId);

  if (lastGen && (now - lastGen) < GENERATION_COOLDOWN_MS) {
    const waitSec = Math.ceil((GENERATION_COOLDOWN_MS - (now - lastGen)) / 1000);
    console.warn(`[RateLimit] userId=${telegramUserId} blocked, retry in ${waitSec}s`);
    return res.status(429).json({
      error: `Слишком много запросов. Подождите ${waitSec} секунд.`,
      code: "RATE_LIMITED",
      retryAfter: waitSec
    });
  }

  _genRateMap.set(telegramUserId, now);

  // Evict stale entries to prevent memory leak
  if (_genRateMap.size > 5000) {
    const cutoff = now - GENERATION_COOLDOWN_MS * 5;
    for (const [uid, ts] of _genRateMap) {
      if (ts < cutoff) _genRateMap.delete(uid);
    }
  }

  next();
}

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
apiRouter.post("/generate",
  generationRateLimitMiddleware,
  upload.fields([{ name: "images", maxCount: 15 }]),
  async (req, res, next) => {
    try {
      // MANDATORY: Log raw request body
      console.log("RAW REQ BODY:", req.body);
      
      // SAFETY CHECK: Handle both single file and multiple files
      const imageFiles = req.files?.images as Express.Multer.File[];
      
      if (!imageFiles || imageFiles.length === 0) {
        return res.status(400).json({ 
          error: "No image files provided. Please upload at least one image.", 
          code: "NO_FILES" 
        });
      }
      
      // Validate images
      for (const file of imageFiles) {
        if (!isValidImageBuffer(file.buffer, file.mimetype)) {
          return res.status(400).json({ 
            error: `Invalid image file: ${file.originalname}. Supported formats: JPEG, PNG, WebP, HEIC.`, 
            code: "INVALID_IMAGE" 
          });
        }
      }

    const packageId = req.body.packageId || "free";
    
    // Parse styleIds (could be JSON string array or a single string)
    let styleIds: string[] = [];
    if (req.body.styleIds) {
      try {
        styleIds = JSON.parse(req.body.styleIds);
      } catch (e) {
        styleIds = Array.isArray(req.body.styleIds) ? req.body.styleIds : [req.body.styleIds];
      }
    }

    // Validate using packages logic
    const validation = validatePackageInput(packageId, imageFiles.length, styleIds);
    if (!validation.ok || !validation.config) {
      return res.status(400).json({ error: validation.error, code: validation.code });
    }
    const config = validation.config;
    
    const id = uuidv4();
    // outputCount is always server-authoritative from package config — never trusted from client
    const outputCount = config.outputCount;
    console.log(`[${id}] New generation request: packageId=${packageId}, mode=${req.body.mode}, outputCount=${outputCount}, files=${imageFiles.length}, styles=${styleIds}`);

    // Save originals
    const originalPaths: string[] = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const path = await storage.save(file.buffer, `${id}_${i}_${file.originalname}`, "original");
      originalPaths.push(path);
    }

    // Calculate expiration from package config
    const retentionMinutes = parseInt(process.env[config.retentionEnvKey] || config.retentionDefault.toString());
    const expiresAt = new Date(Date.now() + retentionMinutes * 60000).toISOString();

    const db = getDb();
    
    // Check if this was triggered from Telegram
    let telegramChatId: number | null = null;
    let telegramUserId: number | null = null;
    
    // Try to get explicit chat_id (attachment menu context)
    if (req.body.telegramChatId) {
      const parsed = parseInt(req.body.telegramChatId, 10);
      telegramChatId = isNaN(parsed) ? null : parsed;
    }
    
    // Always get user_id from Telegram SDK
    if (req.body.telegramUserId) {
      const parsed = parseInt(req.body.telegramUserId, 10);
      telegramUserId = isNaN(parsed) ? null : parsed;
    }

    // STRICT: Block generation if no Telegram user ID
    if (!telegramUserId) {
      return res.status(401).json({ error: "Telegram user ID is required", code: "NO_USER_ID" });
    }
    
    console.log(`Generation ${id}: telegram context - chatId=${telegramChatId}, userId=${telegramUserId}`);

    // ─── Strict Credits Consumption: 1 photo = 1 credit ───────────────
    // mode: 'premium' = only paid_credits; 'preview' = free first, then paid
    const mode: "premium" | "preview" = (req.body.mode === "premium") ? "premium" : "preview";

    if (telegramUserId) {
      const { data: user, error: userError } = await db
        .from("users")
        .select("free_credits, paid_credits")
        .eq("telegram_id", telegramUserId)
        .single();

      if (userError || !user) {
        return res.status(404).json({ error: "User not found", code: "USER_NOT_FOUND" });
      }

      let creditType: "free" | "paid" | null = null;

      if (mode === "premium") {
        // Premium HD: ONLY paid credits allowed
        if ((user.paid_credits ?? 0) > 0) {
          creditType = "paid";
        }
      } else {
        // Preview: free first, then paid
        if ((user.free_credits ?? 0) > 0) {
          creditType = "free";
        } else if ((user.paid_credits ?? 0) > 0) {
          creditType = "paid";
        }
      }

      if (!creditType) {
        return res.status(403).json({ error: "Нет доступных генераций", code: "INSUFFICIENT_FUNDS" });
      }

      // Atomic decrement via RPC
      const { error: consumeError } = await db.rpc("consume_credit", {
        p_telegram_id: telegramUserId,
        p_type: creditType,
      });

      if (consumeError) {
        console.error("Credit consumption error:", consumeError);
        return res.status(500).json({ error: "Failed to consume credit", code: "CREDIT_ERROR" });
      }

      console.log(`[${id}] Consumed 1 ${creditType} credit (mode=${mode}) from user ${telegramUserId}`);
    }

    const { error: insertError } = await db
      .from("generations")
      .insert({
        id,
        user_id: String(telegramUserId),
        type: config.promptTier, // Legacy compat
        package_id: packageId,
        status: "processing",
        original_path: originalPaths[0], // Legacy compat
        reference_paths: originalPaths,  // New array format
        prompt_preset: styleIds[0],      // Legacy compat
        style_ids: styleIds,             // New array format
        results_total: outputCount,
        results_completed: 0,
        expires_at: expiresAt,
        telegram_chat_id: telegramChatId,
        telegram_user_id: telegramUserId
      });

    if (insertError) {
      console.error("Supabase insert error:", insertError);
      return next(new Error("Failed to create generation record"));
    }

    // Return immediately, process in background
    res.json({ id, status: "processing" });

    // Background processing
    try {
      const schedule = buildStyleScheduleWithCount(config, styleIds as StyleId[], outputCount);
      const genConfig = getGenerationConfig(config.id);
      console.log(`[${id}] Schedule: ${schedule.length} images, concurrency=${genConfig.concurrency}, delay=${genConfig.delayMs}ms`);

      // Input curation for premium mode: select best reference photos
      let curatedFiles = imageFiles;
      if (mode === 'premium' && imageFiles.length > 1) {
        const curation = selectBestReferencePhotos(
          imageFiles.map(f => ({ buffer: f.buffer, originalname: f.originalname }))
        );
        console.log(`[${id}] Input curation: ${imageFiles.length} files → ${curation.selectedIndices.length} selected`);
        if (curation.warnings.length > 0) {
          console.log(`[${id}] Curation warnings: ${curation.warnings.join('; ')}`);
        }
        if (curation.hardReject) {
          console.warn(`[${id}] Curation hard reject: ${curation.hardRejectReason}`);
          // Don't block generation — just warn and use all files as fallback
          // The credit is already consumed, so we should still try our best
        }
        if (curation.selectedIndices.length > 0) {
          curatedFiles = curation.selectedIndices.map(i => imageFiles[i]);
        }
      }

      // Prepare images for AI provider
      const baseFile = curatedFiles[0];
      const base64Image = baseFile.buffer.toString("base64");
      const mimeType = baseFile.mimetype;
      
      // For premium mode, prepare additional images as base64
      const additionalImages = mode === 'premium' 
        ? curatedFiles.slice(1).map(file => file.buffer.toString("base64"))
        : [];

      // Progressive state tracking
      let completedCount = 0;
      let failedCount = 0;
      const successPaths: string[] = [];
      const errors: string[] = [];
      let dbUpdateChain = Promise.resolve();

      // Task for generating a single image (with quality gate + reroll)
      const generateOne = async (styleId: StyleId, index: number) => {
        // Defensive: ensure valid StyleId, fallback to business only if undefined
        const validStyleId: StyleId = (styleId && ["business", "lifestyle", "aura", "cinematic", "luxury", "editorial"].includes(styleId)) ? styleId : "business";
        if (validStyleId !== styleId) {
          console.warn(`[${id}] Image ${index}: Invalid styleId "${styleId}", falling back to business`);
        }
        console.log(`[${id}] Image ${index}: Generating with style="${validStyleId}", tier="${config.promptTier}"`);
        const { prompt, negativePrompt } = buildPrompt(config.promptTier, validStyleId, index);

        let resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt, mode, additionalImages);
        let resultBuffer = Buffer.from(resultBase64, "base64");

        // Quality gate (premium only)
        if (mode === 'premium') {
          const gate = await evaluateGeneratedPhoto(
            base64Image, resultBase64, resultBuffer, mimeType, styleId, id, index
          );

          if (gate.shouldReroll) {
            console.log(`[${id}] Image ${index}: quality gate failed (score=${gate.score.overallScore}), attempting reroll...`);
            try {
              resultBase64 = await aiProvider.generateImage(base64Image, mimeType, prompt, mode, additionalImages);
              resultBuffer = Buffer.from(resultBase64, "base64");
              // Re-evaluate after reroll (just log, don't reroll again)
              const rerollGate = await evaluateGeneratedPhoto(
                base64Image, resultBase64, resultBuffer, mimeType, styleId, id, index
              );
              console.log(`[${id}] Image ${index}: reroll result score=${rerollGate.score.overallScore}, pass=${rerollGate.score.overallPass}`);
            } catch (rerollErr: any) {
              console.warn(`[${id}] Image ${index}: reroll failed: ${rerollErr.message}, using original`);
            }
          }
        }

        const resultPath = await storage.save(resultBuffer, `${id}_result_${index}.jpg`, "result");
        return resultPath;
      };

      // Progressive callback — fires after each image finishes (success or fail)
      const onItemComplete = (index: number, result: PromiseSettledResult<string>) => {
        if (result.status === "fulfilled") {
          completedCount++;
          successPaths.push(result.value);
          console.log(`[${id}] Image ${index + 1}/${schedule.length} completed (${completedCount} done)`);
          
          // Progressive Telegram delivery: send each premium photo immediately as it completes.
          // Free (1 image) is delivered in the final batch call below to avoid double-send.
          if (mode === 'premium') {
            const chatTarget = telegramChatId || telegramUserId;
            if (chatTarget) {
              deliverTelegramPhoto(chatTarget, result.value).catch(err =>
                console.error(`[${id}] Progressive delivery failed for image ${index + 1}: ${err.message}`)
              );
            }
          }
        } else {
          failedCount++;
          errors.push(result.reason?.message || "Unknown error");
          console.warn(`[${id}] Image ${index + 1}/${schedule.length} failed: ${result.reason?.message}`);
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

      // Run generation using env-configured concurrency and delay (PREMIUM_CONCURRENCY, INTER_REQUEST_DELAY_MS)
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

      console.log(`[${id}] Done: status=${finalStatus}, completed=${completedCount}, failed=${failedCount}`);

      // Cleanup quality gate reroll tracking
      clearRerollTracking(id);

      // Delete original reference photos from R2 (biometric data retention hygiene)
      try {
        await Promise.all(originalPaths.map(p => storage.delete(p)));
        console.log(`[${id}] Cleaned up ${originalPaths.length} original file(s) from R2`);
      } catch (cleanupErr: any) {
        console.error(`[${id}] R2 cleanup error: ${cleanupErr.message}`);
      }

      // Final Telegram delivery: only for free/preview (1 image).
      // Premium images are already delivered progressively per-image above.
      if (completedCount > 0 && mode !== 'premium') {
        const targetChatId = telegramChatId || telegramUserId;
        if (targetChatId) {
          deliverTelegramResults(targetChatId, successPaths).catch(err => {
            console.error(`Final delivery failed for generation ${id}:`, err);
          });
        }
      }

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

// ─── ETA helpers for processing screen ───────────────────────────────────────────
function etaSecToText(sec: number): string {
  if (sec <= 45)  return "меньше минуты";
  if (sec <= 120)  return "1–2 минуты";
  if (sec <= 240)  return "2–4 минуты";
  if (sec <= 480)  return "4–8 минут";
  return "8+ минут";
}

function computeEtaText(completed: number, total: number, createdAt: string | null): string {
  const remaining = total - completed;
  if (remaining <= 0) return "Почти готово";

  // Dynamic refinement: use observed rate once we have ≥2 completed images
  if (completed >= 2 && createdAt) {
    const elapsedSec = (Date.now() - new Date(createdAt).getTime()) / 1000;
    if (elapsedSec > 5) {
      const avgPerImage = elapsedSec / completed;
      // Cap at 120s/image to prevent wild values from slow initial batches
      const clampedAvg = Math.min(avgPerImage, 120);
      return etaSecToText(clampedAvg * remaining);
    }
  }

  // Baseline estimate by total count (before enough data points)
  if (total <= 1)  return "меньше минуты";
  if (total <= 7)  return "1–3 минуты";
  if (total <= 25) return "3–6 минут";
  return "6–12 минут";
}

// 2. Check Status
apiRouter.get("/status/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const db = getDb();

    const { data: row, error } = await db
      .from("generations")
      .select("id, status, result_path, result_paths, results_completed, results_failed, results_total, error_message, created_at")
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

    const etaText = row.status === "processing"
      ? computeEtaText(row.results_completed || 0, row.results_total || 1, row.created_at || null)
      : null;

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
      etaText,
      error: row.error_message,
    });
  } catch (error) {
    next(error);
  }
});

// ─── Monetization: Packages, Balance, Catalog, Invoice ─────────────────────

const STORE_PACKAGES = [
  { id: "starter", title: "Starter", generations: PACKAGES.starter.outputCount, priceBYN: 9.90, priceRUB: 250, starsPrice: 150 },
  { id: "pro",     title: "Pro",     generations: PACKAGES.pro.outputCount,     priceBYN: 24.90, priceRUB: 650, starsPrice: 350, badge: "ХИТ ПРОДАЖ" },
  { id: "max",     title: "Max",     generations: PACKAGES.max.outputCount,     priceBYN: 49.90, priceRUB: 1300, starsPrice: 750 },
];

// Get user balance (free_credits + paid_credits)
// --- Authentication Endpoint ---
apiRouter.post("/auth", async (req, res, next) => {
  try {
    console.log('AUTH PAYLOAD:', req.body);
    const { telegramId, username } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: "Telegram ID is required" });
    }

    const db = getDb();
    
    // Upsert user: only using telegram_id and username to avoid schema errors
    const { data, error } = await db
      .from("users")
      .upsert(
        {
          telegram_id: parseInt(telegramId, 10),
          username: username || null,
        },
        { onConflict: 'telegram_id', ignoreDuplicates: true } 
      )
      .select("free_credits, paid_credits")
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error("Auth upsert error:", error);
      return res.status(500).json({ error: "Failed to authenticate user", details: error });
    }

    // If ignoreDuplicates hit (user exists), the upsert might return null data depending on Supabase version.
    // Let's just fetch the current balance to return it.
    const { data: user, error: fetchError } = await db
      .from("users")
      .select("free_credits, paid_credits")
      .eq("telegram_id", parseInt(telegramId, 10))
      .single();

    if (fetchError) {
      console.error("Auth fetch error:", fetchError);
      return res.status(500).json({ error: "Failed to fetch user data" });
    }

    res.json({
      success: true,
      freeCredits: user?.free_credits ?? 0,
      paidCredits: user?.paid_credits ?? 0
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/user/balance", async (req, res, next) => {
  try {
    const telegramId = req.query.telegramId as string;
    if (!telegramId) return res.json({ freeCredits: 1, paidCredits: 0 });

    const db = getDb();
    const { data: user } = await db
      .from("users")
      .select("free_credits, paid_credits")
      .eq("telegram_id", telegramId)
      .single();

    if (!user) {
      return res.json({ freeCredits: 1, paidCredits: 0 });
    }

    res.json({
      freeCredits: user.free_credits ?? 0,
      paidCredits: user.paid_credits ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// Get store catalog
apiRouter.get("/payment/catalog", (_req, res) => {
  const catalog = STORE_PACKAGES.map(pkg => ({
    id: pkg.id,
    title: pkg.title,
    generations: pkg.generations,
    priceBYN: pkg.priceBYN,
    priceRUB: pkg.priceRUB,
    starsPrice: pkg.starsPrice,
    badge: (pkg as any).badge || null,
  }));
  res.json({ catalog });
});

// Create Telegram Stars invoice
apiRouter.post("/payment/create-invoice", async (req, res, next) => {
  try {
    const { packageId, telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: "telegramId is required" });
    const pkg = STORE_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: "Package not found" });

    const { getBotInstance } = await import("./telegram.js");
    const bot = getBotInstance();
    if (!bot) return res.status(500).json({ error: "Bot not initialized" });

    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: `MyAURA: ${pkg.title}`,
      description: `+${pkg.generations} генераций фото`,
      payload: `${telegramId}_${packageId}_${Date.now()}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: pkg.title, amount: pkg.starsPrice }],
    });

    res.json({ invoiceLink, starsPrice: pkg.starsPrice });
  } catch (err) {
    next(err);
  }
});
