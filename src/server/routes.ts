import { Router } from "express";

import { v4 as uuidv4 } from "uuid";

import { getDb } from "./db.js";

import { enqueueGenerationTask } from "./tasks.js";

import { storage } from "./storage.js";

import { aiProvider, ImageRef } from "./ai.js";

import { buildFreePrompt, buildPremiumPrompt, StyleId, AgeTier, Gender } from "./prompts.js";

import {

  evaluateAuditGate,

  mergeProfile,

  profileFromUserOnly,

  type SubjectProfile,

} from "./biometric.js";

import { validatePackageInput, buildStyleScheduleWithCount, runBatched, getGenerationConfig, PACKAGES, generationQueue } from "./packages.js";

import { deliverTelegramPhoto, deliverTelegramResults, notifyReferralAwarded, sendTelegramStatus } from "./telegram.js";

import { clearRerollTracking } from "./qualityGate.js";

import { refundCredit, checkRateLimit, clearRateLimit } from "./dbQueue.js";


import { markGenerationStart, markGenerationEnd, isShuttingDown } from "./lifecycle.js";

import {

  MAX_FILE_SIZE_BYTES,

  MAX_FILES_PER_REQUEST,

  PRESIGN_TTL_SEC,

  ALLOWED_UPLOAD_CONTENT_TYPES,

  AllowedUploadContentType,

  buildUploadKey,

  UPLOAD_KEY_REGEX,

  UPLOAD_KEY_PREFIX,

} from "./config/uploads.js";

import { z } from "zod";

import crypto from "crypto";



import { generateGcsUploadUrl } from "./gcs.js";



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



/**

 * Per-user generation rate-limit guard.

 *

 * Returns `true` if the request was denied and a 429 response was sent; the

 * caller must stop processing. Returns `false` if the request may proceed.

 *

 * Defensively coerces the waitSec payload — see checkRateLimit() contract.

 * Never throws: on any internal failure we fail OPEN (return false) rather

 * than lock the user out.

 */

async function enforceGenerationRateLimit(

  req: any,

  res: any,

  telegramUserId: number

): Promise<boolean> {

  if (!telegramUserId || !Number.isFinite(telegramUserId)) return false;



  const cooldownSec = Math.ceil(GENERATION_COOLDOWN_MS / 1000);

  let waitSec: number;

  try {

    waitSec = await checkRateLimit(telegramUserId, cooldownSec);

  } catch (err: any) {

    console.warn(`[RateLimit] check threw, failing open: ${err?.message || err}`);

    return false;

  }



  const safeWait = typeof waitSec === 'number' && Number.isFinite(waitSec)

    ? Math.max(0, Math.floor(waitSec))

    : 0;



  if (safeWait > 0) {

    console.warn(`[RateLimit] userId=${telegramUserId} blocked, retry in ${safeWait}s`);

    res.status(429).json({

      error: `Слишком много запросов. Подождите ${safeWait} секунд.`,

      code: "RATE_LIMITED",

      retryAfter: safeWait,

    });

    // Tag the request for callers that want to attribute the block in logs.

    (req as any).rateLimited = true;

    return true;

  }



  // Successful check — the RPC has already stamped the cooldown window.

  // Mark the request so catch blocks know a rollback is required on failure.

  (req as any).rateLimitStamped = true;

  return false;

}



// Reuse the upload-config allowlist so MIME checks have a single source of truth.

const ALLOWED_IMAGE_MIMES = new Set<string>(ALLOWED_UPLOAD_CONTENT_TYPES);



// ─── Zod schema for POST /api/generate ──────────────────────────────────────

// Single source of truth for every field. Every failure path is surfaced as

// a 400 with the exact field/reason, so regressions are immediately debuggable.

//

// Phase 2: the body is now pure JSON. The client first mints presigned URLs

// via /api/upload-urls, PUTs each original directly to R2, and sends only the

// resulting R2 object keys here — so Cloud Run never touches image bytes on

// the HTTP request path.

const StyleIdEnum = z.enum([

  "business",

  "lifestyle",

  "aura",

  "cinematic",

  "luxury",

  "editorial",

  // Premium-exclusive styles (gated at generation time, not at schema)

  "cyberpunk",

  "corporate",

  "ethereal",

]);



const GenerateBodySchema = z.object({

  packageId: z.enum(["free", "starter", "pro", "max"]),

  mode: z.enum(["preview", "premium"]),

  styleIds: z.array(StyleIdEnum).min(1, "At least one style is required").max(6),

  // V7.0: ageTier + gender are first-class identity anchors. They are merged

  // with the audit fingerprint to build the SubjectProfile that drives both

  // the Imagen subjectDescription and the prompt identity header. Defaults

  // mirror the frontend defaults so older clients still work.

  ageTier: z.enum(["young", "mature", "distinguished"]).optional().default("mature"),

  gender: z.enum(["male", "female", "unset"]).optional().default("unset"),

  telegramUserId: z.coerce.number().int().positive(),

  telegramChatId: z.coerce.number().int().optional(),

  // R2 object keys returned by /api/upload-urls. Regex enforces our canonical

  // "uploads/{telegramUserId}/{uuid}.{ext}" format and rejects anything else

  // (path traversal, cross-user keys, unexpected prefixes).

  imageKeys: z

    .array(z.string().regex(UPLOAD_KEY_REGEX, "Invalid R2 key format"))

    .min(1, "At least one imageKey is required")

    .max(MAX_FILES_PER_REQUEST, `Too many files (max ${MAX_FILES_PER_REQUEST})`),

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



// ─── Zod schema for POST /api/upload-urls ──────────────────────────────────

// Client declares what it intends to upload — name, byte size, MIME — and we

// mint one presigned PUT URL per file. Anything outside declared limits is

// rejected here (before we ever touch R2).

const PresignRequestSchema = z.object({

  packageId: z.enum(["free", "starter", "pro", "max"]),

  files: z

    .array(

      z.object({

        // Original filename — kept for audit only. We do NOT use it to build

        // the R2 key; see buildUploadKey() which uses a server-chosen extension.

        name: z.string().min(1).max(200),

        size: z

          .number()

          .int()

          .positive()

          .max(MAX_FILE_SIZE_BYTES, `File exceeds ${MAX_FILE_SIZE_BYTES} bytes`),

        contentType: z.enum(ALLOWED_UPLOAD_CONTENT_TYPES),

      })

    )

    .min(1, "At least one file is required")

    .max(MAX_FILES_PER_REQUEST, `Too many files (max ${MAX_FILES_PER_REQUEST})`),

});



// ─── POST /api/upload-urls ───────────────────────────────────────────────────

// Mints presigned PUT URLs so the client can upload originals directly to R2,

// completely bypassing the 32 MB Cloud Run request limit.

//

// Security controls layered here:

//   1. initDataAuthMiddleware (applied on apiRouter) — caller is authenticated.

//   2. No rate-limit here — see generationRateLimiter docs above for why.

//   3. Zod schema — size / count / MIME strictly bounded.

//   4. Package count check — free users cannot mint 15 URLs.

//   5. Key format — uploads/{telegramUserId}/{uuid}.{ext}, built server-side.

//      /generate will later verify the prefix matches the caller's userId.

//   6. presignPut() locks Content-Type + Content-Length into the signature.

apiRouter.post(

  "/upload-urls",

  // NO rate-limit middleware here — /upload-urls is a cheap, idempotent-ish

  // URL mint that users legitimately hit multiple times while picking photos.

  // The real throttle lives inside /generate where the credit spend happens.

  async (req, res, next) => {

    try {

      // Auth: telegramId must be set by initDataAuthMiddleware (strict in prod).

      // We accept a body fallback only in non-strict dev — matches auth middleware policy.

      const authedTid: number | undefined = (req as any).telegramId;

      const bodyTid: number | undefined = req.body?.telegramUserId

        ? parseInt(String(req.body.telegramUserId), 10)

        : undefined;

      const isProd = process.env.NODE_ENV === "production";

      const telegramUserId = authedTid || (isProd ? undefined : bodyTid);



      if (!telegramUserId) {

        return res.status(401).json({

          error: "Authenticated Telegram user required",

          code: "NO_USER_ID",

        });

      }



      // Validate request body

      const parseResult = PresignRequestSchema.safeParse(req.body);

      if (!parseResult.success) {

        const details = parseResult.error.issues.map(i => ({

          path: i.path.join(".") || "(root)",

          code: i.code,

          message: i.message,

        }));

        const summary = details.map(d => `${d.path}: ${d.message}`).join("; ");

        console.warn(`[UploadUrls] Validation failed for user=${telegramUserId}: ${summary}`);

        return res.status(400).json({

          error: `Validation failed: ${summary}`,

          code: "VALIDATION_FAILED",

          details,

        });

      }

      const body = parseResult.data;



      // Package count sanity: reject e.g. 15 uploads for a Free package

      const pkg = PACKAGES[body.packageId];

      if (!pkg) {

        return res.status(400).json({ error: "Invalid packageId", code: "INVALID_PACKAGE" });

      }

      if (body.files.length < pkg.minRefs || body.files.length > pkg.maxRefs) {

        return res.status(400).json({

          error: `Package '${body.packageId}' allows ${pkg.minRefs}-${pkg.maxRefs} files, got ${body.files.length}`,

          code: "INVALID_IMAGE_COUNT",

        });

      }



      // Mint presigned URLs in parallel — GCS signing is fast and CPU-bound

      const slots = await Promise.all(

        body.files.map(async file => {

          const key = buildUploadKey(

            telegramUserId,

            uuidv4(),

            file.contentType as AllowedUploadContentType

          );

          // 15 mins = PRESIGN_TTL_SEC / 60

          return storage.presignPut(key, file.contentType, file.size, PRESIGN_TTL_SEC);

        })

      );



      console.log(

        `[UploadUrls] Minted ${slots.length} presigned URL(s) for user=${telegramUserId}, ` +

        `package=${body.packageId}, ttl=${PRESIGN_TTL_SEC}s`

      );



      return res.json({

        uploads: slots,

        ttlSec: PRESIGN_TTL_SEC,

      });

    } catch (err: any) {

      console.error("[UploadUrls] Unexpected error:", err?.message || err);

      next(err);

    }

  }

);



// 1. Start Generation — expects imageKeys previously uploaded via /api/upload-urls.

//    Phase 2 cutover: this endpoint no longer accepts multipart bodies. The client

//    must first call /api/upload-urls, PUT each file to R2, then send only the

//    resulting object keys here. Cloud Run never sees image bytes on the HTTP path.

apiRouter.post("/generate",

  // Rate-limit is enforced INSIDE the handler (not as middleware) so that it

  // only fires after the request passes Zod + auth + package + R2 checks.

  // See enforceGenerationRateLimit() and the rollback block at the bottom.

  async (req, res, next) => {

    try {

      console.log('[Generate] Request received:', {

        body: {

          ...req.body,

          initData: req.body?.initData ? '<redacted>' : undefined,

          imageKeys: Array.isArray(req.body?.imageKeys) ? `[${req.body.imageKeys.length} keys]` : req.body?.imageKeys,

        },

        contentType: req.headers['content-type'],

      });



      // ── Zod validation: single source of truth for every field ──

      const parseResult = GenerateBodySchema.safeParse(req.body);

      if (!parseResult.success) {

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



    const packageId = body.packageId;

    const styleIds: string[] = body.styleIds;

    const imageKeys: string[] = body.imageKeys;



    // ── Authorization: every key must belong to the caller. The regex already

    //    enforces the "uploads/{digits}/{uuid}.{ext}" shape, so here we only

    //    compare the userId segment against the authenticated telegramUserId.

    const expectedPrefix = `${UPLOAD_KEY_PREFIX}${body.telegramUserId}/`;

    const foreignKey = imageKeys.find(k => !k.startsWith(expectedPrefix));

    if (foreignKey) {

      console.warn(

        `[Generate] Cross-user key rejected: user=${body.telegramUserId} key=${foreignKey}`

      );

      return res.status(403).json({

        error: "One or more imageKeys do not belong to the authenticated user.",

        code: "FORBIDDEN_KEY",

      });

    }



    // ── Package constraints (count vs min/max refs, style limits) ──

    const validation = validatePackageInput(packageId, imageKeys.length, styleIds);

    if (!validation.ok || !validation.config) {

      return res.status(400).json({ error: validation.error, code: validation.code });

    }

    const config = validation.config;



    const id = uuidv4();

    // outputCount is always server-authoritative from package config — never trusted from client

    const outputCount = config.outputCount;

    console.log(

      `[${id}] New generation request: packageId=${packageId}, mode=${body.mode}, ` +

      `outputCount=${outputCount}, keys=${imageKeys.length}, styles=${styleIds}`

    );



    // ── Fetch originals from R2 in parallel ──

    // Each slot is verified with headObject (exists + size/type in bounds), then

    // downloaded and magic-byte checked. Any failure aborts the request with

    // the precise key that failed so frontend debugging is trivial.

    type LoadedImage = {

      key: string;

      buffer: Buffer;

      mimetype: string;

      originalname: string;

    };



    const fetchResults = await Promise.all(

      imageKeys.map(async (key): Promise<LoadedImage | { error: string; code: string; key: string }> => {

        const meta = await storage.headObject(key);

        if (!meta.exists) {

          return { error: `R2 object not found: ${key}`, code: "KEY_NOT_FOUND", key };

        }

        if (meta.size == null || meta.size <= 0 || meta.size > MAX_FILE_SIZE_BYTES) {

          return {

            error: `R2 object size out of range (${meta.size} bytes): ${key}`,

            code: "KEY_SIZE_INVALID",

            key,

          };

        }

        const declaredMime = meta.contentType || "";

        if (!ALLOWED_IMAGE_MIMES.has(declaredMime)) {

          return {

            error: `Unsupported content-type '${declaredMime}' on ${key}`,

            code: "KEY_MIME_INVALID",

            key,

          };

        }



        const buffer = await storage.get(key);

        if (!buffer) {

          return { error: `Failed to read R2 object: ${key}`, code: "KEY_READ_FAILED", key };

        }

        if (!isValidImageBuffer(buffer, declaredMime)) {

          return {

            error: `R2 object failed magic-byte check: ${key}`,

            code: "KEY_BYTES_INVALID",

            key,

          };

        }



        // Derive a display-only filename from the key's UUID segment.

        const basename = key.split("/").pop() || "image";

        return { key, buffer, mimetype: declaredMime, originalname: basename };

      })

    );



    const firstFailure = fetchResults.find(r => "error" in r) as

      | { error: string; code: string; key: string }

      | undefined;

    if (firstFailure) {

      console.warn(`[${id}] Key validation failed: ${firstFailure.code} — ${firstFailure.error}`);

      return res.status(400).json({

        error: firstFailure.error,

        code: firstFailure.code,

        key: firstFailure.key,

      });

    }



    const imageFiles = fetchResults as LoadedImage[];



    // ── V7.0 Preflight Biometric Audit ──────────────────────────────────

    // Goal: refuse bad uploads (sunglasses, blur, multi-people, no face)

    // BEFORE consuming the user's credit, AND extract the biometric

    // fingerprint that anchors identity through the rest of the pipeline.

    //

    // Cost: one Gemini 2.5 Flash multimodal call (~3-8s, all refs batched).

    // ROI: prevents wasted Imagen 3 calls (~$0.04 each, ×60 for Max pack)

    //      and produces the rich subjectDescription that lifts likeness

    //      to LoRA-equivalent quality.

    //

    // Failure modes:

    //   - Audit RPC itself errors  → log + skip gate, generate with a

    //     user-only profile (graceful degradation; we never block a paying

    //     user on our own infra failure).

    //   - Audit returns gate=fail → respond 400 PHOTO_QUALITY_REJECTED

    //     with actionable guidance (UI already handles this code).

    const auditTier: "free" | "premium" = body.mode === "premium" ? "premium" : "free";

    const auditRefs: ImageRef[] = imageFiles.map(f => ({

      base64: f.buffer.toString("base64"),

      mimeType: f.mimetype,

    }));

    const userGender: Gender = body.gender;

    const userAgeTier: AgeTier = body.ageTier;

    let profile: SubjectProfile = profileFromUserOnly(userGender, userAgeTier);

    try {

      const auditStart = Date.now();

      const audit = await aiProvider.auditReferences(auditRefs);

      // Pass telegramUserId to support dev God Mode bypass

      const gate = evaluateAuditGate(audit, auditTier, false);

      console.log(

        `[${id}] AUDIT done in ${Date.now() - auditStart}ms | ` +

        `usable=${gate.usableCount}/${gate.totalCount} | pass=${gate.pass} | ` +

        `fp=${audit.fingerprint.perceivedGender}/${audit.fingerprint.apparentAge}/` +

        `${audit.fingerprint.skinTone}/${audit.fingerprint.hairColor}`

      );

      if (!gate.pass) {

        return res.status(400).json({

          error: gate.reason || "Reference photos did not pass the quality check.",

          code: "PHOTO_QUALITY_REJECTED",

          details: {

            usableCount: gate.usableCount,

            totalCount: gate.totalCount,

            rejectedReasons: gate.rejectedReasons,

            perImage: audit.perImage,

          },

        });

      }

      profile = mergeProfile(audit, userGender, userAgeTier);

    } catch (auditErr: any) {

      // Audit infrastructure failure: degrade gracefully. The user-supplied

      // gender/ageTier still anchors prompts, just without rich biometrics.

      console.warn(

        `[${id}] AUDIT failed (${auditErr?.message || auditErr}). ` +

        `Continuing with user-only profile (gender=${userGender}, ageTier=${userAgeTier}).`

      );

    }



    // ── Rate limit: enforced here, AFTER all validation passes, BEFORE any

    //    credit/DB spend. This means invalid requests (Zod, auth, package,

    //    R2) never consume the user's cooldown budget — only legit attempts

    //    do. If any step below this line fails, we MUST call clearRateLimit

    //    in the rollback branches to avoid penalising the user for our bug.

    const rateLimited = await enforceGenerationRateLimit(req, res, body.telegramUserId);

    if (rateLimited) return;



    // R2 keys themselves ARE the "original paths" — no re-upload. This keeps

    // storage ops halved and avoids a window where the copy differs from the

    // reference. Retention cron (Step 6) will sweep uploads/ based on DB refs.

    const originalPaths: string[] = imageKeys;



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

    console.log(`[${id}] mode=${mode} package=${packageId} refs=${imageFiles.length} outputs=${outputCount}`);



    if (telegramUserId) {

      const { data: user, error: userError } = await db

        .from("users")

        .select("free_credits, paid_credits")

        .eq("telegram_id", telegramUserId)

        .single();



      if (userError || !user) {

        if ((req as any).rateLimitStamped) await clearRateLimit(body.telegramUserId);

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

        // No credit → request is rejected without side-effects. Clear the

        // rate-limit stamp so the user can immediately retry after topping up.

        if ((req as any).rateLimitStamped) await clearRateLimit(body.telegramUserId);

        return res.status(403).json({ error: "Нет доступных генераций", code: "INSUFFICIENT_FUNDS" });

      }



      // Atomic decrement via RPC

      const { error: consumeError } = await db.rpc("consume_credit", {

        p_telegram_id: telegramUserId,

        p_type: creditType,

      });



      if (consumeError) {

        console.error("Credit consumption error:", consumeError);

        // DB failure — the consume_credit RPC is atomic so a failure means the

        // credit was NOT debited. Release the rate-limit stamp too so the user

        // can retry without waiting through an unjustified cooldown.

        if ((req as any).rateLimitStamped) await clearRateLimit(body.telegramUserId);

        return res.status(500).json({ error: "Failed to consume credit", code: "CREDIT_ERROR" });

      }



      // Stash creditType on the request so downstream error handlers can refund.

      (req as any).creditType = creditType;



      console.log(`[${id}] Consumed 1 ${creditType} credit (mode=${mode}) from user ${telegramUserId}`);

    }



    // Pull creditType back out for the INSERT so the row is born with the

    // correct bookkeeping columns. The previous code called

    // `markCreditConsumed` BEFORE this insert (an UPDATE against a row that

    // did not yet exist → 0 rows affected), then inserted the generation

    // without `credit_type`. That left every generation with

    // credit_type=NULL, which made the Watchdog's refund path unreachable

    // ("Cannot refund gen=… — missing userId or creditType"). Embedding the

    // field directly in the INSERT is the root-cause fix: one statement, no

    // UPDATE-before-INSERT race, credit_type present from row-birth.

    const insertCreditType = (req as any).creditType as ("free" | "paid" | undefined);

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

        telegram_user_id: telegramUserId,

        // Refund bookkeeping — these MUST be set at row-birth so the watchdog

        // can refund zombies. See comment above.

        credit_type: insertCreditType ?? null,

        credit_consumed: !!insertCreditType,

      });



    if (insertError) {

      console.error("Supabase insert error:", insertError);

      // Insert failed AFTER credit was consumed — refund both the credit AND

      // the rate-limit stamp so the user is not left holding the bag.

      const _creditType = (req as any).creditType as ("free" | "paid" | undefined);

      if (_creditType) {

        await refundCredit(body.telegramUserId, _creditType, id, "generation_insert_failed").catch(

          err => console.warn(`[${id}] refund after insert failure threw:`, err?.message || err)

        );

      }

      if ((req as any).rateLimitStamped) await clearRateLimit(body.telegramUserId);

      return next(new Error("Failed to create generation record"));

    }



    // Return immediately, process in background

    res.json({ id, status: "processing" });



    try {

      await enqueueGenerationTask(id, String(telegramUserId), mode === 'premium' ? 'premium' : 'free', profile);

    } catch (enqueueErr) {

      console.error(`[${id}] Failed to enqueue task:`, enqueueErr);

      // Refund on enqueue failure

      const creditType = (req as any).creditType;

      if (creditType && telegramUserId) {

        await refundCredit(telegramUserId, creditType, id, "enqueue_failed").catch(e => console.error(e));

      }

      await db.from("generations").update({ status: "failed", error_message: "Failed to queue task" }).eq("id", id);

    }

  } catch (error: any) {

    // Guard against "Cannot set headers after they are sent" — we already

    // sent { id, status: "processing" } before background work started, so

    // any late error here must only be logged, never passed to next().

    if (res.headersSent) {

      console.error("[Generate] Post-response error (headers already sent):", error?.message || error);

      return;

    }

    // Uncaught early-path failure: release the rate-limit stamp so the user

    // can retry right away. Any credit side-effect that reached the DB is

    // handled by the watchdog + refund_credit RPC.

    const _tid = parseInt((req as any).body?.telegramUserId, 10);

    if ((req as any).rateLimitStamped && Number.isFinite(_tid)) {

      await clearRateLimit(_tid);

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



