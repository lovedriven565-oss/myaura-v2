// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V8.0 — Enterprise AI Orchestration Layer (Vertex AI)
// ═════════════════════════════════════════════════════════════════════════════
//
// Strict tier separation (Separation of Concerns):
//
//   FREE TIER       → gemini-3.1-flash-image-preview   (region: global, v1beta1)
//                     Zero-shot inlineData, 1→1 output, sub-10s latency target.
//                     Formulaic prompts (see prompts.ts buildFreePrompt).
//
//   PREMIUM TIER    → imagen-3.0-capability-001         (region: us-central1)
//                     Subject Customization via models.editImage() with
//                     SubjectReferenceImage[] (REFERENCE_TYPE_SUBJECT,
//                     SUBJECT_TYPE_PERSON). All uploaded refs share
//                     referenceId=1 so Imagen sees them as multi-view of
//                     the SAME person — this is Google's LoRA-equivalent
//                     mechanism for face identity preservation.
//                     Prompt template uses `[1]` markers (see
//                     prompts.ts buildPremiumImagenPrompt).
//
//   On Imagen failure (429, 503, safety block, region outage, IAM)
//   the premium pipeline degrades gracefully:
//     Imagen 3 → Gemini 3 Pro Image (global) → Gemini 3.1 Flash Image (global)
//   so the queue always completes, even if at lower likeness fidelity.
//
// Deleted in V8.0:
//   - V6 stale comments referring to a `predict`-endpoint that was never
//     actually wired up
//   - V6.0 references to FACE_MESH (Imagen 3 auto-detects face mesh when
//     given REFERENCE_TYPE_SUBJECT + SUBJECT_TYPE_PERSON; explicit FACE_MESH
//     control was over-constraining and killed pose flexibility)
//
// Key pool: ADC-first, with rotating JSON keys if present in ./keys. Every
// request uses a disposable AbortController so timeouts actually close TCP.
// ═════════════════════════════════════════════════════════════════════════════

import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import path from "path";
import {
  AUDIT_PROMPT,
  parseAuditResponse,
  type PreflightAudit,
  type SubjectProfile,
} from "./biometric.js";
import { buildPremiumImagenPrompt, NEGATIVE_PROMPT } from "./prompts.js";
import type { StyleId } from "./prompts.js";

// ─── Public Interface ───────────────────────────────────────────────────────

export interface ImageRef {
  /** Base64-encoded image bytes (no data:; prefix). */
  base64: string;
  /** MIME type, e.g. "image/jpeg" / "image/png" / "image/webp". */
  mimeType: string;
}

export interface IGenerationProvider {
  /**
   * FREE tier. 1-5 refs → 1 output. Target latency < 10s.
   * Uses gemini-3.1-flash-image-preview on the `global` Vertex AI endpoint.
   */
  generateFreeTier(refs: ImageRef[], prompt: string): Promise<string>;

  /**
   * PREMIUM tier. 10-15 refs → 1 output. Background async (V8.0).
   *
   * Primary: imagen-3.0-capability-001 Subject Customization (us-central1)
   *          via models.editImage() — this is Google's LoRA-equivalent for
   *          face identity preservation and produces dramatically better
   *          likeness than the Gemini image models.
   * Fallback 1: gemini-3-pro-image-preview (global)         ← higher quality
   * Fallback 2: gemini-3.1-flash-image-preview (global)     ← always available
   *
   * Caller supplies `styleId`/`index` so we can build the Imagen-flavoured
   * prompt internally (with `[1]` markers required by Subject Customization).
   * The Gemini-flavoured `fallbackPrompt` is what gets used when the
   * primary path fails — it is built externally by `buildPremiumPrompt`.
   *
   * `profile` MUST be provided for Imagen 3 (it drives subjectDescription).
   * If null, we skip Imagen and go straight to the Gemini fallback chain.
   */
  generatePremiumTier(
    refs: ImageRef[],
    fallbackPrompt: string,
    profile: SubjectProfile | null,
    styleId?: StyleId,
    index?: number,
  ): Promise<string>;

  /**
   * Preflight biometric audit. Runs BEFORE credit consumption to catch bad
   * uploads (sunglasses, blur, multi-people, no face) and to extract a
   * structured biometric fingerprint that anchors identity through the rest
   * of the pipeline. One Gemini 2.5 Flash call, all refs batched.
   */
  auditReferences(refs: ImageRef[]): Promise<PreflightAudit>;
}

// ─── Model IDs & Regions ────────────────────────────────────────────────────

const FLASH_MODEL = "gemini-3.1-flash-image-preview";
const PRO_MODEL = "gemini-3-pro-image-preview";

// V8.0: Imagen 3 Subject Customization model. This is the *editing*
// capability model (-capability-001) which supports `referenceImages`
// with REFERENCE_TYPE_SUBJECT — the -generate-001 model does NOT.
// Operators can override via IMAGEN_MODEL_ID for evaluation experiments.
const IMAGEN_MODEL = process.env.IMAGEN_MODEL_ID || "imagen-3.0-capability-001";

// V7.0: dedicated text+vision judge for the preflight audit. Default to
// gemini-2.5-flash (text-output capable); operators can override via
// JUDGE_MODEL_ID for evaluation experiments.
const JUDGE_MODEL = process.env.JUDGE_MODEL_ID || "gemini-2.5-flash";

// Preview Gemini models are served ONLY by the Vertex AI `global` endpoint;
// regional endpoints return 404. Verified 2026-04-21.
const FLASH_LOCATION = "global";
const API_VERSION = "v1beta1";

// Pro uses the same global endpoint as Flash
const PRO_LOCATION = "global";

// Imagen 3 Subject Customization is a regional model. us-central1 is the
// primary GA region; if quota becomes an issue operators can shift to
// us-east4/europe-west4 via IMAGEN_LOCATION_ID.
const IMAGEN_LOCATION = process.env.IMAGEN_LOCATION_ID || "us-central1";
// Imagen uses the v1 stable surface (NOT v1beta1).
const IMAGEN_API_VERSION = "v1";

// ─── Timeouts ────────────────────────────────────────────────────────────────────
// Per-model timeouts are enforced via disposable AbortControllers (httpOptions
// passes the signal into the GoogleGenAI SDK; for raw fetch calls we wire it
// directly). Cloud Run `cpu-throttling: false` is assumed for the Premium
// background path, so generous timeouts are safe — no aggressive hacks.

const FLASH_CALL_TIMEOUT_MS   =  90_000;  // 90s: plenty for a single flash call
const PRO_CALL_TIMEOUT_MS     = 120_000;  // 120s: Pro model is heavier
const IMAGEN_CALL_TIMEOUT_MS  = 180_000;  // 180s: Imagen 3 with refs is slow
const JUDGE_CALL_TIMEOUT_MS   =  45_000;  // 45s: 1 multimodal call, 1-15 imgs in

// ─── Retry tuning (rate-limit resilience) ───────────────────────────────────
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS  = 60_000;

// ─── Safety settings (minimal blocking for real-face portraits) ─────────────
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

// ─── ADC / Project resolution ───────────────────────────────────────────────
// In Cloud Run mode we run on ADC (Application Default Credentials). The SDK
// needs an explicit quota project — ADC does not always carry one, and Vertex
// AI rejects un-projected calls. Operators MUST set GOOGLE_PROJECT_ID or
// GOOGLE_CLOUD_PROJECT on the service.
const VERTEX_ADC_PROJECT = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "";

// Diagnostic (run-once): reveal the real identity Cloud Run gave us.
async function logActiveIdentity(): Promise<void> {
  try {
    const fetch = (await import("node-fetch")).default || globalThis.fetch;
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) },
    );
    if (res.ok) {
      console.log(`[ai] Active ADC identity: ${await res.text()}`);
    }
  } catch {
    /* Not on Cloud Run — ignore. */
  }
}
logActiveIdentity().catch(() => {});

// ─── Key Pool (round-robin with cooldowns) ──────────────────────────────────
// JSON keys are optional. If ./keys contains service-account JSON files, they
// are rotated round-robin; otherwise we fall back to a single ADC slot.

interface KeySlot {
  keyPath: string;
  projectId: string;
  keyHint: string;
  cooldownUntil: number;
  /** True for the single ADC slot. ADC cannot be "exhausted" — issues are
   *  always IAM/config and must be fixed by the operator, not cooled off. */
  isAdc: boolean;
}

const KEY_COOLDOWN_MS = 60_000;       // 1 min on 429
const KEY_FATAL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h on billing

function buildKeyPool(): KeySlot[] {
  const keysDir = path.resolve(process.cwd(), "keys");
  const adcSlot: KeySlot = {
    keyPath: "", projectId: VERTEX_ADC_PROJECT, keyHint: "adc",
    cooldownUntil: 0, isAdc: true,
  };

  if (!fs.existsSync(keysDir)) {
    console.log(`[KeyPool] No ./keys folder — using ADC slot (project=${VERTEX_ADC_PROJECT || "<unset>"})`);
    return [adcSlot];
  }

  const jsonFiles = fs.readdirSync(keysDir)
    .filter(f => f.endsWith(".json") && f !== "dummy.json");

  if (jsonFiles.length === 0) {
    console.log(`[KeyPool] ./keys is empty — using ADC slot`);
    return [adcSlot];
  }

  const slots: KeySlot[] = jsonFiles.map(filename => {
    const keyPath = path.join(keysDir, filename);
    const keyContent = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
    return {
      keyPath,
      projectId: keyContent.project_id || "unknown",
      keyHint: filename.slice(-6),
      cooldownUntil: 0,
      isAdc: false,
    };
  });
  console.log(`[KeyPool] Loaded ${slots.length} JSON key(s) from ./keys`);
  return slots;
}

const keyPool: KeySlot[] = buildKeyPool();
let keyIndex = 0;

// Serialise key selection so parallel workers never grab the same slot
// concurrently (p-queue runs tasks in parallel).
let keySelectChain: Promise<void> = Promise.resolve();
function acquireKeyLock(): Promise<() => void> {
  let release: () => void = () => {};
  const p = new Promise<void>(resolve => { release = resolve; });
  const prev = keySelectChain;
  keySelectChain = prev.then(() => p);
  return prev.then(() => release);
}

async function getNextSlot(): Promise<KeySlot> {
  const unlock = await acquireKeyLock();
  try {
    const now = Date.now();
    const total = keyPool.length;

    for (let i = 0; i < total; i++) {
      const slot = keyPool[(keyIndex + i) % total];
      if (slot.cooldownUntil <= now) {
        keyIndex = ((keyIndex + i) + 1) % total;
        return slot;
      }
    }

    // All slots cooling — wait for the earliest to become available.
    const earliest = keyPool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b);
    const waitMs = Math.max(0, earliest.cooldownUntil - now);
    console.warn(`[KeyPool] All ${total} slot(s) cooling. Waiting ${Math.ceil(waitMs / 1000)}s`);
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    keyIndex = (keyPool.findIndex(s => s === earliest) + 1) % total;
    return earliest;
  } finally {
    unlock();
  }
}

function markCooldown(slot: KeySlot, reason: string): void {
  slot.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  console.warn(`[KeyPool] Slot ${slot.keyHint} cooling for 60s (${reason})`);
}

function markFatalCooldown(slot: KeySlot, reason: string): void {
  if (slot.isAdc) {
    console.error(
      `[IAM FATAL] ${reason} on ADC slot. This is an IAM/config issue, not a quota. ` +
      `Fix: enable aiplatform.googleapis.com + grant roles/aiplatform.user to the ` +
      `Cloud Run service account for project '${slot.projectId || "<unset>"}'.`
    );
    return; // Never 24h-cool ADC: the problem won't heal itself.
  }
  slot.cooldownUntil = Date.now() + KEY_FATAL_COOLDOWN_MS;
  console.error(`[KeyPool] Slot ${slot.keyHint} in 24h cooldown (${reason})`);
}

// ─── Ephemeral client factory ───────────────────────────────────────────────
/**
 * Builds a GoogleGenAI client bound to the given AbortSignal so timeouts
 * actually close TCP sockets. Uses `vertexai: true` + explicit project/location
 * — without these the SDK silently falls back to AI Studio mode and demands
 * an API key, which manifests as a confusing 403 on Cloud Run.
 */
function createClient(
  slot: KeySlot,
  signal: AbortSignal,
  location: string,
  apiVersion: string,
): GoogleGenAI {
  const opts: Record<string, any> = {
    httpOptions: { signal },
    vertexai: true,
    location,
    apiVersion,
  };

  if (slot.keyPath) {
    const prev = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = slot.keyPath;
    opts.project = slot.projectId;
    const client = new GoogleGenAI(opts);
    if (prev !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = prev;
    else delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    return client;
  }

  if (!VERTEX_ADC_PROJECT) {
    throw new Error(
      "[ai] ADC mode requires GOOGLE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) env var."
    );
  }
  opts.project = VERTEX_ADC_PROJECT;
  return new GoogleGenAI(opts);
}

// ─── Error classification ───────────────────────────────────────────────────
interface ErrorClass {
  is429: boolean;
  isBilling: boolean;
  isIamDenied: boolean;
  isNotFound: boolean;
  isSafetyBlock: boolean;
}

function classifyError(err: any): ErrorClass {
  const msg = (err?.message || String(err || "")).toLowerCase();
  const blob = `${msg} ${safeStringify(err)}`.toLowerCase();
  const status = err?.status ?? err?.error?.code ?? err?.code;

  const is429 = status === 429 || /rate.?limit|resource_exhausted|\b429\b/.test(blob);
  const isBilling = /billing|account_disabled|project_disabled/.test(blob);
  const isIamDenied = !isBilling && (
    status === 403 ||
    /iam_permission_denied|permission_denied/.test(blob)
  );
  const isNotFound = status === 404 || /\b404\b|not_found/.test(blob);
  const isSafetyBlock = /safety|blocked|prohibited_content/.test(blob);
  return { is429, isBilling, isIamDenied, isNotFound, isSafetyBlock };
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v ?? ""); }
}

// ─── Retry wrapper (exponential backoff with jitter, 429-aware) ─────────────
async function withRateLimitRetry<T>(op: () => Promise<T>, opName: string): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await op();
    } catch (err: any) {
      const cls = classifyError(err);
      if (!cls.is429 || attempt >= MAX_RETRIES) throw err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt))
                  + Math.floor(Math.random() * 1000);
      console.warn(`[Retry] ${opName} 429. Sleeping ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`[${opName}] unreachable retry branch`);
}

// ─── VertexAIProvider (the only provider in V6.0) ──────────────────────────
export class VertexAIProvider implements IGenerationProvider {

  // ═════ FREE TIER ════════════════════════════════════════════════════════
  async generateFreeTier(refs: ImageRef[], prompt: string): Promise<string> {
    if (!refs || refs.length === 0) throw new Error("generateFreeTier: refs[] required");
    console.log(`[FREE] flash | refs=${refs.length} | region=${FLASH_LOCATION}`);
    return withRateLimitRetry(
      () => this._callGeminiImage(FLASH_MODEL, FLASH_LOCATION, FLASH_CALL_TIMEOUT_MS, refs, prompt, 0.4, 0.95, "FREE.flash"),
      "FREE.flash",
    );
  }

  // ═════ PREMIUM TIER (V8.0: Imagen 3 → Pro → Flash) ══════════════════════════
  async generatePremiumTier(
    refs: ImageRef[],
    fallbackPrompt: string,
    profile: SubjectProfile | null,
    styleId?: StyleId,
    index?: number,
  ): Promise<string> {
    if (!refs || refs.length === 0) throw new Error("generatePremiumTier: refs[] required");

    // ── Primary path: Imagen 3 Subject Customization (when profile + styleId)
    // This is the only Vertex AI model with a documented LoRA-equivalent
    // face-preservation mechanism. Skip only if upstream couldn't audit
    // (no profile) or didn't pass styleId (back-compat for legacy callers).
    if (profile && styleId !== undefined && index !== undefined) {
      console.log(
        `[PREMIUM] imagen | refs=${refs.length} | region=${IMAGEN_LOCATION} | ` +
        `style=${styleId} | profile=${profile.gender}/${profile.ageTier}`
      );
      try {
        return await withRateLimitRetry(
          () => this._callImagen3SubjectCustomization(refs, profile, styleId, index),
          "PREMIUM.imagen",
        );
      } catch (imgErr: any) {
        const msg = (imgErr?.message || String(imgErr)).slice(0, 300);
        console.warn(`[PREMIUM] imagen failed → falling back to gemini pro. err=${msg}`);
      }
    } else {
      console.log(
        `[PREMIUM] imagen SKIPPED → gemini pro | reason=` +
        `${!profile ? "no-profile" : "no-styleId"}`
      );
    }

    // ── Fallback 1: Gemini 3 Pro Image (general image model)
    console.log(
      `[PREMIUM-FALLBACK] pro | refs=${refs.length} | region=${PRO_LOCATION} | ` +
      `profile=${profile ? `${profile.gender}/${profile.ageTier}` : "none"}`
    );
    try {
      return await withRateLimitRetry(
        () => this._callGeminiImage(PRO_MODEL, PRO_LOCATION, PRO_CALL_TIMEOUT_MS, refs, fallbackPrompt, 0.1, 0.9, "PREMIUM.pro"),
        "PREMIUM.pro",
      );
    } catch (proErr: any) {
      const msg = (proErr?.message || String(proErr)).slice(0, 300);
      console.warn(`[PREMIUM] pro failed → falling back to flash. err=${msg}`);
    }

    // ── Fallback 2: Gemini 3.1 Flash Image (always-available)
    console.log(`[PREMIUM-FALLBACK] flash | refs=${refs.length} | region=${FLASH_LOCATION}`);
    return withRateLimitRetry(
      () => this._callGeminiImage(FLASH_MODEL, FLASH_LOCATION, FLASH_CALL_TIMEOUT_MS, refs, fallbackPrompt, 0.1, 0.9, "PREMIUM.flash-fallback"),
      "PREMIUM.flash-fallback",
    );
  }

  // ═════ AUDIT ═════════════════════════════════════════════════════════════
  async auditReferences(refs: ImageRef[]): Promise<PreflightAudit> {
    if (!refs || refs.length === 0) throw new Error("auditReferences: refs[] required");
    console.log(`[AUDIT] judge=${JUDGE_MODEL} | refs=${refs.length}`);
    return withRateLimitRetry(
      () => this._callJudgeJSON(refs, AUDIT_PROMPT),
      "AUDIT.judge",
    );
  }

  // ─── Imagen 3 Subject Customization (V8.1 — raw REST predict) ──────────
  /**
   * V8.1 — Raw `predict` REST call, bypassing the @google/genai SDK.
   *
   * Why raw REST instead of SDK editImage():
   *   - The SDK's `editImage()` does NOT propagate `guidanceScale` into the
   *     final HTTP `instances.parameters` — observed in production logs.
   *     Without CFG control, Imagen 3 defaults to its baseline guidance and
   *     refuses to lock the reference identity tightly.
   *   - The SDK at certain versions also injected `controlImageConfig` with
   *     CONTROL_TYPE_FACE_MESH automatically, which Vertex either rejects
   *     (400) or interprets as a hybrid Customization+Control payload that
   *     breaks identity preservation. We need a *minimal* Subject-only
   *     payload, end of story.
   *
   * Payload shape (per Vertex AI v1 publishers/google/models/imagen-3.0-
   * capability-001:predict):
   *   {
   *     instances: [{
   *       prompt: "...[1]...",
   *       referenceImages: [{
   *         referenceType: "REFERENCE_TYPE_SUBJECT",
   *         referenceId: 1,
   *         referenceImage: { bytesBase64Encoded, mimeType },
   *         subjectImageConfig: {
   *           subjectType: "SUBJECT_TYPE_PERSON",
   *           subjectDescription: "the exact person shown in the reference images"
   *         }
   *       }, ...]
   *     }],
   *     parameters: {
   *       sampleCount: 1,
   *       aspectRatio: "3:4",
   *       guidanceScale: 5.0,
   *       personGeneration: "allow_all",
   *       negativePrompt: "...",
   *       safetySetting: "block_only_high",
   *       includeRaiReason: true,
   *       language: "en"
   *     }
   *   }
   *
   * Notes:
   *   - Imagen 3 Subject Customization allows max 2 refs for non-square
   *     aspect ratios. Audit ranks refs by quality so refs[0..1] are used.
   *   - All subject refs share `referenceId: 1` — multi-view of the SAME person.
   *   - A 3rd ref (`referenceId: 2`) with CONTROL_TYPE_FACE_MESH locks
   *     facial geometry to the best audit-ranked photo (Google-recommended).
   *   - `guidanceScale: 7.0` strengthens visual-embedding adherence vs text.
   */
  private async _callImagen3SubjectCustomization(
    refs: ImageRef[],
    profile: SubjectProfile,
    styleId: StyleId,
    index: number,
  ): Promise<string> {
    const slot = await getNextSlot();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGEN_CALL_TIMEOUT_MS);
    const label = "PREMIUM.imagen";

    try {
      const { prompt, subjectDescription } = buildPremiumImagenPrompt(styleId, index, profile);

      // Imagen 3 Subject Customization allows max 2 refs for non-square
      // aspect ratios (e.g. 3:4, 9:16). Audit already ranked refs by quality.
      const usableRefs = refs.slice(0, 2);

      const subjectImages = usableRefs.map((r, i) => ({
        referenceType: "REFERENCE_TYPE_SUBJECT",
        referenceId: 1,  // ALL refs share id=1 → "same person, multi-view"
        referenceImage: {
          bytesBase64Encoded: r.base64,
          mimeType: r.mimeType,
        },
        subjectImageConfig: {
          subjectType: "SUBJECT_TYPE_PERSON",
          subjectDescription,
        },
        _viewIndex: i,  // stripped before send; only for log clarity
      })).map(({ _viewIndex: _, ...keep }) => keep);

      const referenceImages = subjectImages;

      const payload = {
        instances: [{
          prompt,
          referenceImages,
        }],
        parameters: {
          sampleCount: 1,
          aspectRatio: "3:4",
          guidanceScale: 4.0,
          personGeneration: "allow_all",
          negativePrompt: NEGATIVE_PROMPT,
          safetySetting: "block_only_high",
          includeRaiReason: true,
          language: "en",
        },
      };

      // Auth: GoogleAuth honours GOOGLE_APPLICATION_CREDENTIALS (set per-slot
      // for JSON keys) and falls back to ADC otherwise.
      const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!slot.isAdc) process.env.GOOGLE_APPLICATION_CREDENTIALS = slot.keyPath;
      const auth = new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      const accessTokenObj = await auth.getAccessToken();
      const accessToken = typeof accessTokenObj === "string"
        ? accessTokenObj
        : (accessTokenObj as any)?.token;
      if (prevCreds !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
      else if (!slot.isAdc) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!accessToken) throw new Error(`[${label}] failed to obtain access token`);

      const projectId = slot.isAdc ? VERTEX_ADC_PROJECT : slot.projectId;
      if (!projectId) throw new Error(`[${label}] no project id resolved`);

      const url =
        `https://${IMAGEN_LOCATION}-aiplatform.googleapis.com/${IMAGEN_API_VERSION}/projects/${projectId}` +
        `/locations/${IMAGEN_LOCATION}/publishers/google/models/${IMAGEN_MODEL}:predict`;

      console.log(
        `[${label}] model=${IMAGEN_MODEL} refs=${referenceImages.length}/${refs.length} ` +
        `(subj=${subjectImages.length}) cfg=${payload.parameters.guidanceScale} ` +
        `desc="${subjectDescription}" prompt[0..160]="${prompt.slice(0, 160)}"`
      );

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "<unreadable>");
        const err: any = new Error(
          `[${label}] HTTP ${response.status}: ${bodyText.slice(0, 500)}`
        );
        err.status = response.status;
        err.responseBody = bodyText;
        throw err;
      }

      const json: any = await response.json();
      const predictions: any[] = json?.predictions || [];
      if (predictions.length === 0) {
        throw new Error(`[${label}] response had no predictions`);
      }

      // Imagen 3 returns either bytesBase64Encoded (preferred) or imageBytes.
      const first = predictions[0];
      const imageBytes: string | undefined =
        first?.bytesBase64Encoded || first?.imageBytes;
      if (!imageBytes) {
        const raiReason = first?.raiFilteredReason;
        if (raiReason) {
          throw Object.assign(new Error(`[${label}] safety filter: ${raiReason}`), {
            isSafetyBlock: true,
          });
        }
        throw new Error(
          `[${label}] no image bytes in prediction (keys=${Object.keys(first || {}).join(",")})`
        );
      }
      return imageBytes;
    } catch (err: any) {
      clearTimeout(timeoutId);
      this._classifyAndCooldown(slot, err, label);
      if (controller.signal.aborted) {
        throw Object.assign(
          new Error(`[${label}] timeout after ${IMAGEN_CALL_TIMEOUT_MS}ms`),
          { isTimeout: true },
        );
      }
      throw err;
    }
  }

  // ─── Gemini Image Generation (shared by free, premium fallback, and free) ──
  private async _callGeminiImage(
    modelId: string,
    location: string,
    timeoutMs: number,
    refs: ImageRef[],
    prompt: string,
    temperature: number,
    topP: number,
    label: string,
  ): Promise<string> {
    const slot = await getNextSlot();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const client = createClient(slot, controller.signal, location, API_VERSION);

      // Multimodal payload: image parts first, then text prompt.
      const contents: any[] = refs.map(r => ({
        inlineData: { data: r.base64, mimeType: r.mimeType },
      }));
      contents.push({ text: prompt });

      const response = await client.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore — SDK type doesn't expose responseModalities yet
          responseModalities: ["IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature,
          topP,
        },
      } as any);

      clearTimeout(timeoutId);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData?.data) return part.inlineData.data;
      }
      throw new Error(`[${label}] model returned no image parts`);
    } catch (err: any) {
      clearTimeout(timeoutId);
      this._classifyAndCooldown(slot, err, label);
      if (controller.signal.aborted) {
        throw Object.assign(
          new Error(`[${label}] timeout after ${timeoutMs}ms`),
          { isTimeout: true },
        );
      }
      throw err;
    }
  }

  // ─── Judge call (preflight biometric audit, JSON output) ─────────────
  /**
   * One Gemini 2.5 Flash multimodal call. All reference images go in as
   * inlineData parts; the prompt asks for strict JSON. We return the
   * parsed PreflightAudit shape via parseAuditResponse().
   */
  private async _callJudgeJSON(refs: ImageRef[], prompt: string): Promise<PreflightAudit> {
    const slot = await getNextSlot();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), JUDGE_CALL_TIMEOUT_MS);

    try {
      const client = createClient(slot, controller.signal, FLASH_LOCATION, API_VERSION);

      const contents: any[] = refs.map(r => ({
        inlineData: { data: r.base64, mimeType: r.mimeType },
      }));
      contents.push({ text: prompt });

      const response = await client.models.generateContent({
        model: JUDGE_MODEL,
        contents,
        config: {
          // @ts-ignore — SDK type doesn't expose responseMimeType cleanly
          responseMimeType: "application/json",
          safetySettings: SAFETY_SETTINGS,
          temperature: 0.1,
          topP: 0.9,
        },
      } as any);

      clearTimeout(timeoutId);

      // Concatenate any text parts the model returned. Most callers see one,
      // but we are defensive in case the SDK splits the JSON across parts.
      const parts = response.candidates?.[0]?.content?.parts || [];
      const raw = parts.map((p: any) => p.text || "").join("").trim();
      if (!raw) throw new Error(`[judge] model returned no text`);

      return parseAuditResponse(raw, refs.length);
    } catch (err: any) {
      clearTimeout(timeoutId);
      this._classifyAndCooldown(slot, err, "judge");
      if (controller.signal.aborted) {
        throw Object.assign(
          new Error(`[judge] timeout after ${JUDGE_CALL_TIMEOUT_MS}ms`),
          { isTimeout: true },
        );
      }
      throw err;
    }
  }

  // ─── Error → cooldown router ──────────────────────────────────────────
  private _classifyAndCooldown(slot: KeySlot, err: any, label: string): void {
    const cls = classifyError(err);
    const msg = (err?.message || String(err || "")).slice(0, 200);
    if (cls.isBilling) {
      markFatalCooldown(slot, `${label} billing disabled`);
    } else if (cls.is429) {
      markCooldown(slot, `${label} 429`);
    } else if (cls.isIamDenied) {
      // IAM issues are operator-fixable, not transient. Log loudly.
      console.error(`[IAM] ${label} on slot ${slot.keyHint}: ${msg}`);
    }
    // isNotFound / isSafetyBlock / other errors: no cooldown needed,
    // caller decides whether to retry/fallback.
  }
}

// ─── Default export ─────────────────────────────────────────────────────────
export const aiProvider: IGenerationProvider = new VertexAIProvider();
