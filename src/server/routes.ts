import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { storage } from "./storage.js";
import { aiProvider } from "./ai.js";
import { buildPrompt, StyleId, AgeTier, Gender } from "./prompts.js";
import { validatePackageInput, buildStyleSchedule, buildStyleScheduleWithCount, runBatched, getGenerationConfig, PACKAGES, generationQueue } from "./packages.js";
import { deliverTelegramPhoto, deliverTelegramResults, notifyReferralAwarded } from "./telegram.js";
import { selectBestReferencePhotos } from "./inputCuration.js";
import { evaluateGeneratedPhoto, clearRerollTracking } from "./qualityGate.js";
import { enqueueGeneration, refundCredit, markCreditConsumed, checkRateLimit } from "./dbQueue.js";
import { updateGenerationHeartbeat } from "./watchdog.js";
import { z } from "zod";
import crypto from "crypto";

export const apiRouter = Router();

// ─── Telegram initData Validation (Security) ─────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const INIT_DATA_MAX_AGE_SECONDS = 86400; // 24 hours — Telegram refreshes initData per session launch

// One-time sanity log on startup: lets the operator spot a missing / mismatched
// bot token without leaking the full secret. If this prefix does not match the
// token BotFather shows for the bot that hosts the Mini App, ALL signatures
// will fail and every user will see AuthError.
{
  const prefix = BOT_TOKEN ? `${BOT_TOKEN.slice(0, 6)}...${BOT_TOKEN.slice(-4)}` : "<MISSING>";
  console.log(`[Auth] Bot token prefix in use: ${prefix} | INIT_DATA_STRICT=${process.env.INIT_DATA_STRICT === "true"}`);
}

/**
 * Best-effort parse of the `user` field from a raw initData string.
 * Used only for non-strict fallback — does NOT imply signature is valid.
 */
function extractUserIdFromRawInitData(initData: string): number | undefined {
  try {
    const pairs = initData.split("&");
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.substring(0, eq);
      if (key !== "user") continue;
      const raw = pair.substring(eq + 1);
      const decoded = decodeURIComponent(raw);
      const user = JSON.parse(decoded);
      return typeof user?.id === "number" ? user.id : undefined;
    }
  } catch {
    /* ignore — caller treats undefined as "no identity" */
  }
  return undefined;
}

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
  matchedStrategy?: "decoded" | "raw";
} {
  if (!initData || !BOT_TOKEN) {
    return { valid: false, error: "Missing initData or BOT_TOKEN" };
  }

  try {
    // Parse initData manually. For each key we keep BOTH the raw URL-encoded
    // value and the URL-decoded value, because different Telegram clients
    // (and different spec revisions) disagree on which form is signed. The
    // official reference implementations (python `urllib.parse.parse_qsl`,
    // @tma.js/init-data-node via URLSearchParams.entries()) use the decoded
    // form, but some older/third-party clients pass the raw form. We check
    // both below and accept the first match — identity is still anchored to
    // a correct HMAC, just computed against whichever canonical form the
    // signer used.
    const paramsRaw: Record<string, string> = {};
    const paramsDecoded: Record<string, string> = {};
    const pairs = initData.split("&");
    let hash: string | null = null;

    for (const pair of pairs) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;

      const key = pair.substring(0, eqIndex);
      const rawValue = pair.substring(eqIndex + 1);

      if (key === "hash") {
        hash = rawValue;
        continue;
      }
      paramsRaw[key] = rawValue;
      try {
        paramsDecoded[key] = decodeURIComponent(rawValue);
      } catch {
        // Malformed percent-encoding — fall back to raw so at least one
        // strategy has a chance.
        paramsDecoded[key] = rawValue;
      }
    }

    if (!hash) {
      return { valid: false, error: "Missing hash in initData" };
    }

    // Check auth_date freshness (anti-replay protection)
    const authDate = paramsDecoded["auth_date"] || paramsRaw["auth_date"];
    if (!authDate) {
      return { valid: false, error: "Missing auth_date in initData" };
    }
    {
      const now = Math.floor(Date.now() / 1000);
      const authTimestamp = parseInt(authDate, 10);
      const age = now - authTimestamp;
      if (age > INIT_DATA_MAX_AGE_SECONDS || age < -60) {
        return { valid: false, error: `initData expired or invalid (age=${age}s, max=${INIT_DATA_MAX_AGE_SECONDS}s)` };
      }
    }

    // Secret key: HMAC-SHA256("WebAppData", bot_token). Reused for both strategies.
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();

    const buildDataCheckString = (params: Record<string, string>) =>
      Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("\n");

    const computeHash = (dcs: string) =>
      crypto.createHmac("sha256", secretKey).update(dcs).digest("hex");

    const dcsDecoded = buildDataCheckString(paramsDecoded);
    const dcsRaw = buildDataCheckString(paramsRaw);
    const hashDecoded = computeHash(dcsDecoded);
    const hashRaw = computeHash(dcsRaw);

    const matched: "decoded" | "raw" | null =
      hashDecoded === hash ? "decoded" :
      hashRaw === hash ? "raw" :
      null;

    if (!matched) {
      // Safe diagnostic: log only non-secret fragments so operator can see
      // why validation fails without exposing the bot token or full user data.
      console.warn(
        `[Auth] Signature mismatch. initDataLen=${initData.length} ` +
        `receivedHash=${hash.slice(0, 8)}.. ` +
        `computedDecoded=${hashDecoded.slice(0, 8)}.. ` +
        `computedRaw=${hashRaw.slice(0, 8)}.. ` +
        `keys=[${Object.keys(paramsDecoded).sort().join(",")}]`
      );
      return { valid: false, error: "Invalid initData signature" };
    }

    // Extract telegramId from decoded user payload
    let telegramId: number | undefined;
    const userJson = paramsDecoded["user"];
    if (userJson) {
      try {
        const user = JSON.parse(userJson);
        if (typeof user?.id === "number") telegramId = user.id;
      } catch {
        /* validation passed but user payload unparseable — non-fatal */
      }
    }

    return { valid: true, telegramId, matchedStrategy: matched };
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

  // HARD-ENFORCE strict mode in production, regardless of env var.
  // Dev only gets the bypass — production NEVER trusts unsigned identity.
  const isProd = process.env.NODE_ENV === "production";
  const isStrict = isProd || process.env.INIT_DATA_STRICT === "true";

  if (!initData) {
    // Allow requests without initData for non-Telegram clients (dev/testing)
    if (isStrict) {
      return res.status(401).json({ error: "Missing initData authentication" });
    }
    return next();
  }

  const validation = validateInitData(initData);

  if (!validation.valid) {
    console.warn(`[Auth] Invalid initData: ${validation.error}`);

    // BYPASS MODE: if strict=false, log warning but allow request through.
    // We still best-effort parse user.id from the UNSIGNED payload so
    // downstream routes (e.g. /api/auth) have identity. This mirrors the
    // pre-refactor UX for dev / misconfigured-token environments. Identity
    // is NOT cryptographically verified — strict mode must be enabled in
    // production to enforce that.
    if (!isStrict) {
      const rawId = extractUserIdFromRawInitData(initData);
      if (rawId) {
        req.telegramId = rawId;
        console.warn(`[Auth] Invalid signature; trusting UNSIGNED user.id=${rawId} (INIT_DATA_STRICT=false)`);
      } else {
        console.warn("[Auth] Invalid signature and no parseable user.id; passing anonymous (INIT_DATA_STRICT=false)");
      }
      return next();
    }

    return res.status(401).json({ error: "Invalid authentication", details: validation.error });
  }

  // Attach validated telegramId to request for downstream use
  if (validation.telegramId) {
    req.telegramId = validation.telegramId;
  }

  next();
}

// ─── Telegram Stars Webhook Handler (mounted directly in server.ts for public access) ───────────────
/**
 * POST /api/webhook/telegram
 * Unified webhook for all Telegram payment events:
 * - pre_checkout_query: approve payment UI
 * - successful_payment: add credits (idempotent)
 * 
 * NOTE: This handler is mounted directly on app in server.ts BEFORE the global /api router
 * to ensure it's publicly accessible without auth middleware
 */
export async function telegramWebhookHandler(req: any, res: any, next: any) {
  try {
    console.log("[Webhook] Request received:", {
      method: req.method,
      path: req.path,
      contentType: req.headers['content-type'],
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : 'none'
    });
    
    // 1. Pre-checkout: approve payment UI
    if (req.body?.pre_checkout_query) {
      const { pre_checkout_query } = req.body;
      console.log(`[PreCheckout] Approved query_id=${pre_checkout_query.id}, user=${pre_checkout_query.from?.id}`);
      return res.json({ ok: true });
    }

    // 2. Successful payment: add credits
    if (req.body?.message?.successful_payment) {
      const payment = req.body.message.successful_payment;
      const telegramId = req.body.message.from?.id;
      const payload = payment.invoice_payload;  // Format: "telegramId_packageId_timestamp"

      console.log(`[Payment] Successful payment from ${telegramId}, payload=${payload}`);

      // Parse payload
      const parts = payload.split('_');
      if (parts.length < 2) {
        console.warn(`[Payment] Invalid payload format: ${payload}`);
        return res.json({ ok: true }); // Always return 200 to Telegram, log error locally
      }

      const packageId = parts[1];
      const pkg = STORE_PACKAGES.find(p => p.id === packageId);

      if (!pkg) {
        console.error(`[Payment] Package not found: ${packageId}`);
        return res.json({ ok: true }); // Always return 200 to Telegram
      }

      // Add credits via RPC (idempotent via telegram_payment_charge_id)
      const db = getDb();
      const { data: success, error } = await db.rpc('add_paid_credits', {
        p_telegram_id: telegramId,
        p_credits: pkg.generations,
        p_package_id: packageId,
        p_stars_amount: payment.total_amount,
        p_telegram_charge_id: payment.telegram_payment_charge_id,
        p_payload: payload
      });

      if (error) {
        console.error(`[Payment] RPC error:`, error);
        return res.json({ ok: true }); // Always return 200 to Telegram, log error locally
      }

      if (!success) {
        console.log(`[Payment] Duplicate payment, already processed: ${payment.telegram_payment_charge_id}`);
        return res.json({ ok: true, message: "Already processed" });
      }

      console.log(`[Payment] Added ${pkg.generations} credits to user ${telegramId}`);
      return res.json({ ok: true, creditsAdded: pkg.generations });
    }

    // 3. Unknown event: acknowledge but ignore (ALWAYS return 200 OK to Telegram)
    console.log(`[Webhook] Unknown event type, body keys: ${req.body ? Object.keys(req.body).join(', ') : 'no body'}`);
    return res.json({ ok: true });

  } catch (err) {
    next(err);
  }
}

// Get store catalog (PUBLIC - exclude hidden test packages)
apiRouter.get("/payment/catalog", (_req, res) => {
  const catalog = STORE_PACKAGES
    .filter(pkg => !pkg.hidden)
    .map(pkg => ({
      id: pkg.id,
      title: pkg.title,
      generations: pkg.generations,
      priceBYN: pkg.priceBYN,
      priceRUB: pkg.priceRUB,
      starsPrice: pkg.starsPrice,
      badge: pkg.badge || null
    }));
  res.json({ catalog });
});

// Apply initData auth middleware to all API routes AFTER this point
apiRouter.use(initDataAuthMiddleware);

// ─── Referral B-lite: Award Logic ────────────────────────────────────────────
// Called after a free generation reaches status=completed.
// Fully isolated: errors here never affect the generation result.
async function tryAwardReferral(inviteeId: number, generationId: string): Promise<void> {
  try {
    const db = getDb();

    // Fetch invitee's referred_by_code
    const { data: invitee } = await db
      .from("users")
      .select("referred_by_code")
      .eq("telegram_id", inviteeId)
      .single();

    const refCode = invitee?.referred_by_code;
    if (!refCode) return; // Not a referred user

    // Call the atomic RPC that handles all guards (self-ref, cap, idempotency)
    const { data: awarded, error } = await db
      .rpc("award_referral_bonus", {
        p_referrer_code: refCode,
        p_invitee_id: inviteeId,
        p_gen_id: generationId,
      });

    if (error) {
      console.error(`[Referral] award_referral_bonus error for invitee=${inviteeId}:`, error.message);
      return;
    }

    if (!awarded) {
      console.log(`[Referral] No award for invitee=${inviteeId} (cap/self-ref/duplicate)`);
      return;
    }

    console.log(`[Referral] Award granted: invitee=${inviteeId}, refCode=${refCode}, gen=${generationId}`);

    // Lookup referrer telegram_id for notification
    const { data: referrer } = await db
      .from("users")
      .select("telegram_id")
      .eq("referral_code", refCode)
      .single();

    if (referrer?.telegram_id) {
      notifyReferralAwarded(referrer.telegram_id).catch(err =>
        console.error(`[Referral] Telegram notify failed for referrer=${referrer.telegram_id}:`, err.message)
      );
    }
  } catch (err: any) {
    console.error(`[Referral] tryAwardReferral unexpected error:`, err.message);
  }
}

// ─── Per-user Generation Rate Limiter (CloudRun-safe via PostgreSQL) ─────────
const GENERATION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes per user

async function generationRateLimitMiddleware(req: any, res: any, next: any) {
  const telegramUserId = parseInt(req.body?.telegramUserId, 10);
  if (!telegramUserId || isNaN(telegramUserId)) return next();

  const cooldownSec = Math.ceil(GENERATION_COOLDOWN_MS / 1000);
  const waitSec = await checkRateLimit(telegramUserId, cooldownSec);

  if (waitSec > 0) {
    console.warn(`[RateLimit] userId=${telegramUserId} blocked, retry in ${waitSec}s`);
    return res.status(429).json({
      error: `Слишком много запросов. Подождите ${waitSec} секунд.`,
      code: "RATE_LIMITED",
      retryAfter: waitSec
    });
  }

  next();
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit per file

const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

// ─── Zod schema for POST /api/generate ──────────────────────────────────────
// Validates every field with a single source of truth. Any field that fails
// returns 400 with the exact path + reason, so the frontend (or us, debugging)
// knows precisely what broke.
//
// Note on styleIds: the frontend sends JSON.stringify(["business"]) in a
// multipart/form-data field, so we accept either a JSON-encoded string or an
// already-parsed array and normalise to string[] via z.preprocess.
const StyleIdEnum = z.enum(["business", "lifestyle", "aura", "cinematic", "luxury", "editorial"]);

const GenerateBodySchema = z.object({
  packageId: z.enum(["free", "starter", "pro", "max"]),
  mode: z.enum(["preview", "premium"]),
  styleIds: z.preprocess(
    (raw) => {
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
          try { return JSON.parse(trimmed); } catch { return [trimmed]; }
        }
        return [trimmed];
      }
      return raw;
    },
    z.array(StyleIdEnum).min(1, "At least one style is required").max(6)
  ),
  ageTier: z.enum(["young", "mature", "distinguished"]).default("young"),
  gender: z.enum(["male", "female", "unset"]).default("unset"),
  telegramUserId: z.coerce.number().int().positive(),
  telegramChatId: z.coerce.number().int().optional(),
});

export type GenerateBody = z.infer<typeof GenerateBodySchema>;

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
  (req, res, next) => generationRateLimitMiddleware(req, res, next),
  upload.fields([{ name: "images", maxCount: 15 }]),
  async (req, res, next) => {
    try {
      console.log('[Generate] Request received:', {
        body: { ...req.body, initData: req.body?.initData ? '<redacted>' : undefined },
        files: req.files ? 'present' : 'missing',
        contentType: req.headers['content-type'],
      });

      // ── Zod validation: single source of truth for every field ──
      const parseResult = GenerateBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        // Build a human-readable list of which fields failed and why.
        // This is the difference between "400 Bad Request" and actionable debug info.
        const details = parseResult.error.issues.map(issue => ({
          path: issue.path.join(".") || "(root)",
          code: issue.code,
          message: issue.message,
        }));
        const summary = details.map(d => `${d.path}: ${d.message}`).join("; ");
        console.warn(`[Generate] Zod validation failed: ${summary}`);
        return res.status(400).json({
          error: `Validation failed: ${summary}`,
          code: "VALIDATION_FAILED",
          details,
        });
      }
      const body = parseResult.data;

      // ── File presence + magic-byte validation ──
      const imageFiles = (req.files as { [fieldname: string]: Express.Multer.File[] })?.images;
      if (!imageFiles || imageFiles.length === 0) {
        return res.status(400).json({
          error: "No image files provided. Please upload at least one image.",
          code: "NO_FILES",
        });
      }

      for (const file of imageFiles) {
        if (!isValidImageBuffer(file.buffer, file.mimetype)) {
          return res.status(400).json({
            error: `Invalid image file: ${file.originalname}. Supported formats: JPEG, PNG, WebP, HEIC.`,
            code: "INVALID_IMAGE",
          });
        }
      }

    const packageId = body.packageId;
    const styleIds: string[] = body.styleIds;

    // Validate package-specific constraints (ref count, max styles)
    const validation = validatePackageInput(packageId, imageFiles.length, styleIds);
    if (!validation.ok || !validation.config) {
      return res.status(400).json({ error: validation.error, code: validation.code });
    }
    const config = validation.config;
    
    const id = uuidv4();
    // outputCount is always server-authoritative from package config — never trusted from client
    const outputCount = config.outputCount;
    console.log(`[${id}] New generation request: packageId=${packageId}, mode=${body.mode}, outputCount=${outputCount}, files=${imageFiles.length}, styles=${styleIds}`);

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

    // Telegram context from validated body (already coerced to numbers by Zod)
    const telegramUserId: number = body.telegramUserId;
    const telegramChatId: number | null = body.telegramChatId ?? null;

    console.log(`Generation ${id}: telegram context - chatId=${telegramChatId}, userId=${telegramUserId}`);

    // ─── Strict Credits Consumption: 1 photo = 1 credit ───────────────
    // mode: 'premium' = only paid_credits; 'preview' = free first, then paid
    const mode: "premium" | "preview" = body.mode;
    const ageTier: AgeTier = body.ageTier;
    const gender: Gender = body.gender;
    console.log(`[${id}] ageTier=${ageTier} gender=${gender} mode=${mode}`);

    // ── Free V2: quality-gate BEFORE credit consumption ──────────────
    const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
    let freeV2CuratedIndices: number[] = [];

    if (FREE_V2 && mode !== 'premium' && imageFiles.length > 1) {
      const curation = await selectBestReferencePhotos(
        imageFiles.map(f => ({ buffer: f.buffer, originalname: f.originalname })),
        { mode: 'free' },
      );
      console.log(`[${id}] [FREE_V2] Curation: ${imageFiles.length}→${curation.selectedIndices.length} selected | ${curation.telemetry.latencyMs}ms`);
      if (curation.warnings.length > 0) {
        console.log(`[${id}] [FREE_V2] Warnings: ${curation.warnings.join('; ')}`);
      }
      if (curation.hardReject) {
        console.warn(`[${id}] [FREE_V2] HARD REJECT: ${curation.hardRejectReason}`);
        return res.status(400).json({
          error: curation.hardRejectReason,
          code: "PHOTO_QUALITY_REJECTED",
        });
      }
      freeV2CuratedIndices = curation.selectedIndices;
      console.log(`[${id}] [FREE_V2] Selected indices: [${freeV2CuratedIndices.join(',')}]`);
    }

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

      // Record that credit was consumed (for potential refund if generation fails)
      await markCreditConsumed(id, creditType);
      (req as any).creditType = creditType;  // Store for error handling

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

      // Resolve final reference files for generation
      // Free V2 (flag ON): use pre-curated files from quality gate above
      // All other cases: use original uploaded files (stable behavior)
      const finalFiles = (FREE_V2 && mode !== 'premium' && freeV2CuratedIndices.length > 0)
        ? freeV2CuratedIndices.map(i => imageFiles[i])
        : imageFiles;

      // Prepare images for AI provider
      const baseFile = finalFiles[0];
      const base64Image = baseFile.buffer.toString("base64");
      const mimeType = baseFile.mimetype;
      
      // Additional reference images
      // Premium: pass all uploaded refs (original stable behavior, unchanged)
      // Free V2 (flag ON): pass curated additional refs
      // Free (flag OFF): no additional images (single file only)
      let additionalImages: string[] = [];
      if (mode === 'premium' && imageFiles.length > 1) {
        additionalImages = imageFiles.slice(1).map(file => file.buffer.toString("base64"));
      } else if (FREE_V2 && mode !== 'premium' && finalFiles.length > 1) {
        additionalImages = finalFiles.slice(1).map(file => file.buffer.toString("base64"));
      }

      // Session isolation trace
      console.log(`[${id}] SESSION CONTEXT: userId=${telegramUserId}, refs=${finalFiles.length}, base64Len=${base64Image.length}, additionalRefs=${additionalImages.length}, freeV2=${FREE_V2}`);

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
        const { prompt, negativePrompt } = buildPrompt(config.promptTier, validStyleId, index, ageTier, gender);

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
              // A2: Reroll must also respect the global queue and rate limits
              resultBase64 = await generationQueue.add(() => 
                aiProvider.generateImage(base64Image, mimeType, prompt, mode, additionalImages)
              ) as string;
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
          const errMsg = result.reason?.message || String(result.reason) || "Unknown error";
          errors.push(errMsg);
          console.error(`╔═══ [${id}] IMAGE ${index + 1}/${schedule.length} FAILED ═══╗`);
          console.error(`  Reason : ${errMsg}`);
          console.error(`  Stack  : ${result.reason?.stack || "no stack available"}`);
          console.error(`╚${"═".repeat(50)}╝`);
        }

        // Chain DB updates sequentially to avoid race conditions.
        // Also bump last_heartbeat_at so the watchdog does not reclaim
        // a legitimately-long-running batch (e.g. Max package, 60 images).
        dbUpdateChain = dbUpdateChain.then(() =>
          db.from("generations").update({
            results_completed: completedCount,
            results_failed: failedCount,
            result_path: successPaths[0] || null,
            result_paths: [...successPaths],
            last_heartbeat_at: new Date().toISOString(),
          }).eq("id", id).then(() => {})
        ).catch(err => console.error("Progressive DB update error:", err));

        // Fire-and-forget explicit RPC heartbeat (cheaper than a full UPDATE,
        // and serves as a backup in case the chained UPDATE above is queued).
        updateGenerationHeartbeat(id).catch(() => { /* already logged inside */ });
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

      // Referral award: fire after first completed free generation
      if (finalStatus === "completed" && mode !== "premium" && telegramUserId) {
        tryAwardReferral(telegramUserId, id).catch(() => {}); // errors are logged inside
      }

      // Final Telegram delivery: only for free/preview (1 image).
      // Premium images are already delivered progressively per-image above.
      let deliveryFailed = false;
      if (completedCount > 0 && mode !== 'premium') {
        const targetChatId = telegramChatId || telegramUserId;
        if (targetChatId) {
          try {
            await deliverTelegramResults(targetChatId, successPaths);
            console.log(`[${id}] Telegram delivery successful`);
          } catch (deliveryErr: any) {
            deliveryFailed = true;
            console.error(`[${id}] Telegram delivery failed:`, deliveryErr);
            // Refund credit if delivery failed - user didn't receive their photo
            if ((req as any).creditType && telegramUserId) {
              const refunded = await refundCredit(
                telegramUserId,
                (req as any).creditType,
                id,
                `Telegram delivery failed: ${deliveryErr.message}`
              );
              if (refunded) {
                console.log(`[${id}] Credit refunded due to Telegram delivery failure`);
              }
            }
          }
        }
      }

      // REFUND LOGIC: If generation completely failed (0 completed), refund credit
      const creditType = (req as any).creditType;
      if (completedCount === 0 && creditType && telegramUserId && !deliveryFailed) {
        const refunded = await refundCredit(
          telegramUserId,
          creditType,
          id,
          `Generation failed: ${finalErrorMsg || 'All images failed to generate'}`
        );
        if (refunded) {
          console.log(`[${id}] Credit refunded due to complete generation failure`);
        }
      }

    } catch (genError: any) {
      console.error("Generation batch failed:", genError);
      await db
        .from("generations")
        .update({ status: "failed", error_message: genError.message })
        .eq("id", id);
      
      // REFUND: Critical error during generation - always refund
      const creditType = (req as any).creditType;
      if (creditType && telegramUserId) {
        try {
          const refunded = await refundCredit(
            telegramUserId,
            creditType,
            id,
            `Critical generation error: ${genError.message}`
          );
          if (refunded) {
            console.log(`[${id}] Credit refunded due to critical error`);
          }
        } catch (refundErr: any) {
          console.error(`[${id}] Failed to refund after critical error:`, refundErr);
        }
      }
    }
  } catch (error: any) {
    // Guard against "Cannot set headers after they are sent" — we already
    // sent { id, status: "processing" } before background work started, so
    // any late error here must only be logged, never passed to next().
    if (res.headersSent) {
      console.error("[Generate] Post-response error (headers already sent):", error?.message || error);
      return;
    }
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
      .select("id, status, result_path, result_paths, results_completed, results_failed, results_total, error_message, created_at, telegram_user_id")
      .eq("id", id)
      .single();

    if (error || !row) {
      return res.status(404).json({ error: "Generation not found", code: "NOT_FOUND" });
    }

    // Owner check: if caller identifies themselves, validate ownership
    const callerTgId = req.query.tgUserId as string | undefined;
    if (callerTgId && row.telegram_user_id && String(row.telegram_user_id) !== String(callerTgId)) {
      return res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
    }

    // Auto-heal: server restart may have killed in-flight tasks leaving status stuck at "processing"
    let currentStatus = row.status as string;
    const completed = row.results_completed || 0;
    const failed = row.results_failed || 0;
    const total = row.results_total || 1;

    if (currentStatus === "processing" && total > 0 && (completed + failed) >= total) {
      currentStatus = completed > 0 ? "partial" : "failed";
      await db.from("generations").update({ status: currentStatus }).eq("id", id);
    }

    const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "";
    const resultUrl = row.result_path ? `${publicBaseUrl}/${row.result_path}` : null;
    const resultUrls = Array.isArray(row.result_paths) 
      ? row.result_paths.map((p: string) => `${publicBaseUrl}/${p}`) 
      : (resultUrl ? [resultUrl] : []);

    const etaText = currentStatus === "processing"
      ? computeEtaText(completed, total, row.created_at || null)
      : null;

    res.json({
      id: row.id,
      status: currentStatus,
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

// 3. Cancel Generation
apiRouter.post("/cancel/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const db = getDb();
    const { error } = await db
      .from("generations")
      .update({ status: "cancelled" })
      .eq("id", id)
      .in("status", ["processing", "pending"]); // only cancel if still running
    if (error) console.warn(`[cancel] DB update error for ${id}:`, error.message);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ─── Monetization: Packages, Balance, Catalog, Invoice ─────────────────────

const STORE_PACKAGES = [
  { id: "TEST_1_STAR", title: "Тест: 1 генерация", generations: 1, priceBYN: 0.01, priceRUB: 1, starsPrice: 1, hidden: true },
  { id: "starter", title: "Starter", generations: PACKAGES.starter.outputCount, priceBYN: 9.90, priceRUB: 250, starsPrice: 150 },
  { id: "pro",     title: "Pro",     generations: PACKAGES.pro.outputCount,     priceBYN: 24.90, priceRUB: 650, starsPrice: 350, badge: "ХИТ ПРОДАЖ" },
  { id: "max",     title: "Max",     generations: PACKAGES.max.outputCount,     priceBYN: 49.90, priceRUB: 1300, starsPrice: 750 },
];

// Get user balance (free_credits + paid_credits)
// --- Authentication Endpoint ---
// SECURITY: telegramId is sourced from cryptographically validated initData,
// NEVER from the request body. Body is only consulted when INIT_DATA_STRICT=false
// (local dev) to allow smoke-testing without a real Telegram WebApp context.
apiRouter.post("/auth", async (req, res, next) => {
  try {
    const { username, startParam } = req.body || {};
    const isStrict = process.env.INIT_DATA_STRICT === "true";

    // Primary source: validated initData (set by initDataAuthMiddleware).
    let tid: number | undefined = (req as any).telegramId;

    // Dev-only fallback: accept body.telegramId ONLY when strict mode is off.
    if (!tid && !isStrict && req.body?.telegramId) {
      tid = parseInt(req.body.telegramId, 10);
    }

    if (!tid || isNaN(tid)) {
      return res.status(401).json({ error: "Authenticated Telegram user required" });
    }

    const db = getDb();
    
    // Upsert user: only using telegram_id and username to avoid schema errors
    const { error } = await db
      .from("users")
      .upsert(
        {
          telegram_id: tid,
          username: username || null,
        },
        { onConflict: 'telegram_id', ignoreDuplicates: true } 
      );

    if (error && error.code !== 'PGRST116') {
      console.error("Auth upsert error:", error);
      return res.status(500).json({ error: "Failed to authenticate user", details: error });
    }

    // Ensure referral_code exists for this user (generates one if missing)
    const { data: referralCodeRow } = await db
      .rpc("ensure_referral_code", { p_telegram_id: tid });
    const referralCode: string | null = referralCodeRow ?? null;

    // One-time attribution: write referred_by_code only if currently NULL
    if (startParam && typeof startParam === "string" && startParam.startsWith("ref_")) {
      await db.rpc("set_referred_by", { p_telegram_id: tid, p_ref_code: startParam });
      console.log(`[Referral] Attribution: user=${tid} referred_by=${startParam}`);
    }

    // Fetch current balance
    const { data: user, error: fetchError } = await db
      .from("users")
      .select("free_credits, paid_credits")
      .eq("telegram_id", tid)
      .single();

    if (fetchError) {
      console.error("Auth fetch error:", fetchError);
      return res.status(500).json({ error: "Failed to fetch user data" });
    }

    const { data: activeGen } = await db
      .from("generations")
      .select("id")
      .eq("telegram_user_id", tid)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    res.json({
      success: true,
      freeCredits: user?.free_credits ?? 0,
      paidCredits: user?.paid_credits ?? 0,
      activeGenerationId: activeGen?.id || null,
      referralCode,
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/user/balance", async (req, res, next) => {
  try {
    const isStrict = process.env.INIT_DATA_STRICT === "true";
    let tid: number | undefined = (req as any).telegramId;

    // Dev-only fallback: accept query.telegramId when strict mode is off.
    if (!tid && !isStrict && req.query?.telegramId) {
      const parsed = parseInt(req.query.telegramId as string, 10);
      if (!isNaN(parsed)) tid = parsed;
    }

    if (!tid) {
      return res.status(401).json({ error: "Authenticated Telegram user required" });
    }

    const db = getDb();
    const { data: user } = await db
      .from("users")
      .select("free_credits, paid_credits")
      .eq("telegram_id", tid)
      .single();

    if (!user) {
      return res.json({ freeCredits: 0, paidCredits: 0 });
    }

    res.json({
      freeCredits: user.free_credits ?? 0,
      paidCredits: user.paid_credits ?? 0,
    });
  } catch (err) {
    next(err);
  }
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

