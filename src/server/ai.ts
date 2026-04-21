// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V6.0 — Enterprise AI Orchestration Layer (Vertex AI)
// ═════════════════════════════════════════════════════════════════════════════
//
// Strict tier separation (Separation of Concerns):
//
//   FREE TIER       → gemini-3.1-flash-image-preview   (region: global, v1beta1)
//                     Zero-shot inlineData, 1→1 output, sub-10s latency target.
//                     Formulaic prompts (see prompts.ts buildFreePrompt).
//
//   PREMIUM TIER    → imagen-3.0-generate-001           (region: us-central1)
//                     Subject Customization via `predict` endpoint:
//                       - REFERENCE_TYPE_SUBJECT for every uploaded photo
//                       - REFERENCE_TYPE_CONTROL (FACE_MESH) anchor
//                     7/25/60 output batches, background async.
//                     On any failure (429, 503, safety block, region outage)
//                     the pipeline seamlessly falls back to Flash on `global`
//                     so the queue always completes.
//
// Deleted in V6.0:
//   - CustomJob Instant Tuning pipeline (experimental, never productionised)
//   - imagen-3.0-capability-001 references (404 on every endpoint)
//   - 3-tier fallback spaghetti (preview/pro/region ping-pong)
//   - cross-region roulette (quota is strictly region-bound)
//
// Key pool: ADC-first, with rotating JSON keys if present in ./keys. Every
// request uses a disposable AbortController so timeouts actually close TCP.
// ═════════════════════════════════════════════════════════════════════════════

import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import { NEGATIVE_PROMPT } from "./prompts";

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
   * PREMIUM tier. 10-15 refs → 1 output. Background async.
   * Primary: imagen-3.0-generate-001 Subject Customization (us-central1).
   * Fallback: gemini-3.1-flash-image-preview (global) with multi-ref inline.
   */
  generatePremiumTier(refs: ImageRef[], prompt: string): Promise<string>;
}

// ─── Model IDs & Regions ────────────────────────────────────────────────────

const FLASH_MODEL = "gemini-3.1-flash-image-preview";
const IMAGEN_MODEL = "imagen-3.0-generate-001";

// Preview Gemini models are served ONLY by the Vertex AI `global` endpoint;
// regional endpoints return 404. Verified 2026-04-21.
const FLASH_LOCATION = "global";
const FLASH_API_VERSION = "v1beta1";

// Imagen `predict` is REGIONAL. `global` is invalid for Imagen. Allow override
// so ops can flip between us-central1 (default) and europe-west4 without code
// changes if one region exhibits a local outage or quota pressure.
const IMAGEN_LOCATION_ALLOWLIST = new Set<string>(["us-central1", "europe-west4"]);
function resolveImagenLocation(): string {
  const raw = (process.env.VERTEX_AI_IMAGEN_LOCATION || "").trim();
  if (!raw) return "us-central1";
  if (!IMAGEN_LOCATION_ALLOWLIST.has(raw)) {
    console.warn(
      `[ai] VERTEX_AI_IMAGEN_LOCATION='${raw}' is not allowed ` +
      `(${[...IMAGEN_LOCATION_ALLOWLIST].join(", ")}). Falling back to us-central1.`
    );
    return "us-central1";
  }
  return raw;
}
const IMAGEN_LOCATION = resolveImagenLocation();

// ─── Timeouts ───────────────────────────────────────────────────────────────
// Per-model timeouts are enforced via disposable AbortControllers (httpOptions
// passes the signal into the GoogleGenAI SDK; for raw fetch calls we wire it
// directly). Cloud Run `cpu-throttling: false` is assumed for the Premium
// background path, so generous timeouts are safe — no aggressive hacks.

const FLASH_CALL_TIMEOUT_MS   =  90_000;  // 90s: plenty for a single flash call
const IMAGEN_CALL_TIMEOUT_MS  = 120_000;  // 120s: Subject Customization is heavier

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
      () => this._callFlash(refs, prompt, /*temp*/ 0.4, /*topP*/ 0.95),
      "FREE.flash",
    );
  }

  // ═════ PREMIUM TIER ═════════════════════════════════════════════════════
  async generatePremiumTier(refs: ImageRef[], prompt: string): Promise<string> {
    if (!refs || refs.length === 0) throw new Error("generatePremiumTier: refs[] required");

    // Primary: Imagen 3 Subject Customization.
    console.log(`[PREMIUM] imagen | refs=${refs.length} | region=${IMAGEN_LOCATION}`);
    try {
      return await withRateLimitRetry(
        () => this._callImagenSubjectCustomization(refs, prompt),
        "PREMIUM.imagen",
      );
    } catch (imagenErr: any) {
      const msg = (imagenErr?.message || String(imagenErr)).slice(0, 300);
      console.error("🚨 IMAGEN FAILED: FALLING BACK TO FLASH", imagenErr);
      console.warn(`[PREMIUM] imagen failed → falling back to flash. err=${msg}`);
    }

    // Graceful fallback: Flash (global) with all refs inline.
    console.log(`[PREMIUM-FALLBACK] flash | refs=${refs.length} | region=${FLASH_LOCATION}`);
    return withRateLimitRetry(
      () => this._callFlash(refs, prompt, /*temp*/ 0.1, /*topP*/ 0.9),
      "PREMIUM.flash-fallback",
    );
  }

  // ─── Flash call (shared by free and premium fallback) ─────────────────
  private async _callFlash(
    refs: ImageRef[],
    prompt: string,
    temperature: number,
    topP: number,
  ): Promise<string> {
    const slot = await getNextSlot();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FLASH_CALL_TIMEOUT_MS);

    try {
      const client = createClient(slot, controller.signal, FLASH_LOCATION, FLASH_API_VERSION);

      // Multimodal payload: image parts first, then text prompt.
      const contents: any[] = refs.map(r => ({
        inlineData: { data: r.base64, mimeType: r.mimeType },
      }));
      contents.push({ text: prompt });

      const response = await client.models.generateContent({
        model: FLASH_MODEL,
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
      throw new Error(`[flash] model returned no image parts`);
    } catch (err: any) {
      clearTimeout(timeoutId);
      this._classifyAndCooldown(slot, err, "flash");
      if (controller.signal.aborted) {
        throw Object.assign(
          new Error(`[flash] timeout after ${FLASH_CALL_TIMEOUT_MS}ms`),
          { isTimeout: true },
        );
      }
      throw err;
    }
  }

  // ─── Imagen 3 Subject Customization (predict endpoint) ────────────────
  private async _callImagenSubjectCustomization(
    refs: ImageRef[],
    prompt: string,
  ): Promise<string> {
    const slot = await getNextSlot();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGEN_CALL_TIMEOUT_MS);

    try {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({
        keyFile: slot.isAdc ? undefined : slot.keyPath,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        projectId: slot.projectId || VERTEX_ADC_PROJECT,
      });
      const authClient = await auth.getClient();
      const { token: accessToken } = await authClient.getAccessToken();
      if (!accessToken) throw new Error("[imagen] failed to obtain GCP access token");

      const project = slot.projectId || VERTEX_ADC_PROJECT;
      const url =
        `https://${IMAGEN_LOCATION}-aiplatform.googleapis.com/v1beta1/` +
        `projects/${project}/locations/${IMAGEN_LOCATION}/publishers/google/models/${IMAGEN_MODEL}:predict`;

      // Build reference images:
      //   id 1..N  : REFERENCE_TYPE_SUBJECT (each uploaded photo, up to 15)
      //   id 99    : REFERENCE_TYPE_CONTROL (FACE_MESH anchor, first ref)
      const subjectRefs = refs.map((r, idx) => ({
        referenceType: "REFERENCE_TYPE_SUBJECT",
        referenceId: idx + 1,
        referenceImage: { bytesBase64Encoded: r.base64, mimeType: r.mimeType },
        subjectImageConfig: {
          subjectDescription:
            idx === 0
              ? "primary subject portrait: exact facial geometry, haircut, and skin texture"
              : "additional reference of the same person from another angle",
          subjectType: "SUBJECT_TYPE_PERSON",
        },
      }));

      const faceMeshRef = {
        referenceType: "REFERENCE_TYPE_CONTROL",
        referenceId: 99,
        referenceImage: { bytesBase64Encoded: refs[0].base64, mimeType: refs[0].mimeType },
        controlImageConfig: {
          controlType: "CONTROL_TYPE_FACE_MESH",
          enableControlImageComputation: true,
        },
      };

      const body = {
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: "9:16",
          personGeneration: "ALLOW_ADULT",
          negativePrompt: NEGATIVE_PROMPT,
          referenceImages: [...subjectRefs, faceMeshRef],
        },
      };

      console.log("🔍 IMAGEN PAYLOAD:", JSON.stringify(body, null, 2));

      const fetchFn = (await import("node-fetch")).default || globalThis.fetch;
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      } as any);

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw Object.assign(
          new Error(`[imagen] predict HTTP ${response.status}: ${errText.slice(0, 400)}`),
          { status: response.status },
        );
      }

      const data = await response.json() as any;
      const predictions = data?.predictions || [];
      if (predictions.length === 0) {
        throw new Error(`[imagen] predict returned no predictions: ${safeStringify(data).slice(0, 400)}`);
      }
      const b64 = predictions[0]?.bytesBase64Encoded;
      if (!b64) {
        // Possible safety block: the body usually contains raiFilteredReason.
        const reason = predictions[0]?.raiFilteredReason || "no bytesBase64Encoded";
        throw new Error(`[imagen] prediction missing image bytes: ${reason}`);
      }
      return b64;
    } catch (err: any) {
      clearTimeout(timeoutId);
      this._classifyAndCooldown(slot, err, "imagen");
      if (controller.signal.aborted) {
        throw Object.assign(
          new Error(`[imagen] timeout after ${IMAGEN_CALL_TIMEOUT_MS}ms`),
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
