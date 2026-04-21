import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode?: 'preview' | 'premium', additionalImages?: string[]): Promise<string>;
}

// ─── MyAURA Model Stack (Vertex AI) ─────────────────────────────────────────
// v3.5 GLOBAL-FIX (2026-04-21):
//   Both preview models (gemini-3-pro-image-preview and
//   gemini-3.1-flash-image-preview) are only exposed via the Vertex AI
//   `global` endpoint with apiVersion `v1beta1`. All regional endpoints
//   (europe-west4/1, us-central1) return 404 NOT_FOUND — verified via
//   probe on 2026-04-21 against project myaura-production-492012.
//   No Imagen fallbacks — they were unstable in production (500s +
//   "fetch failed (other side closed)" crashing the event loop into SIGTERM).
const FREE_MODEL_PRIMARY = "gemini-3.1-flash-image-preview";
const PRO_MODEL_PRIMARY  = "gemini-3-pro-image-preview";

// Retry configuration for resilience against 429 rate limits
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 15000; // 15s base
const MAX_DELAY_MS = 60000;  // cap at 60s

// Per-model call timeout. Keyed on model ID so future variants (Pro, 3.x)
// pick up their own values once added. Unknown models fall back to DEFAULT.
const MODEL_CALL_TIMEOUT_MS: Record<string, number> = {
  ["gemini-2.5-flash-image"]:          90_000,
  ["gemini-3.1-flash-image-preview"]:  90_000,
  ["gemini-3-pro-image-preview"]:     120_000,
};
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

function stringifyErrorDetails(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

// ─── Transient network error detection (v3.6) ───────────────────────────────
// The gemini-3-pro-image-preview endpoint occasionally drops TCP mid-response
// ("fetch failed", "other side closed", ECONNRESET, socket hang up) and
// sometimes returns 500/503 under load. These are retryable: the quota is
// still healthy, only the transport broke. 429/403/404 are NOT handled here —
// those are classified elsewhere (billing / IAM / quota).
function isTransientNetworkError(err: any): boolean {
  const msg = (err?.message || String(err || "")).toLowerCase();
  const status = err?.status ?? err?.error?.code ?? err?.code;

  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (err?.isTimeout === true) return true;                 // our own AbortError translation
  if (err?.name === "AbortError") return true;
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("other side closed")) return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("econnaborted")) return true;
  if (msg.includes("network error")) return true;
  if (msg.includes("upstream connect error")) return true;
  if (msg.includes("terminated") && msg.includes("socket")) return true;

  return false;
}

const NETWORK_RETRY_MAX_ATTEMPTS = 2;   // 2 retries on top of the initial try = 3 total
const NETWORK_RETRY_DELAY_MS     = 10_000;

async function withNetworkRetry<T>(
  op: () => Promise<T>,
  opName: string,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= NETWORK_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err: any) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt >= NETWORK_RETRY_MAX_ATTEMPTS) {
        throw err;
      }
      const waitMs = NETWORK_RETRY_DELAY_MS;
      console.warn(
        `[NetRetry] ${opName} transient failure (attempt ${attempt + 1}/${NETWORK_RETRY_MAX_ATTEMPTS + 1}): ` +
        `${(err?.message || String(err)).slice(0, 160)} — retrying in ${waitMs}ms`
      );
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/**
 * Exponential backoff with jitter for resilient API calls
 * Formula: min(t_max, t_base * 2^attempt + random_jitter)
 */
async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      const isRateLimit = error?.status === 429 ||
                         error?.message?.includes("429") ||
                         error?.message?.includes("RESOURCE_EXHAUSTED") ||
                         error?.code === 429;
      // Key went to 24h cooldown (IAM/billing both models failed) — retry on next key immediately
      const isKeyExhausted = !!(error?.isKeyExhausted);

      if (isKeyExhausted && attempt < maxRetries) {
        console.warn(`[Retry] ${operationName} key exhausted. Switching key (attempt ${attempt + 1}/${maxRetries})...`);
        // No delay — getNextClient() will wait for cooldown if needed
        continue;
      }

      if (!isRateLimit || attempt >= maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter: min(t_max, t_base * 2^attempt + random_jitter)
      const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 1000); // 0-1000ms random jitter
      const delayMs = Math.min(MAX_DELAY_MS, exponentialDelay + jitter);

      console.warn(`[Retry] ${operationName} failed with 429. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`withExponentialBackoff: unreachable`);
}

// ─── Round-Robin Key Pool ───────────────────────────────────────────────────
// KeySlot no longer holds a long-lived client.
// A fresh GoogleGenAI instance with a disposable AbortController is created
// per-request so TCP connections are ACTUALLY closed on timeout/abort.

// DIAGNOSTIC: Fetch actual Cloud Run service account email
async function printDiagnosticIdentity() {
  try {
    const fetch = (await import('node-fetch')).default || globalThis.fetch;
    const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000)
    });
    if (res.ok) {
      console.log(`[Diagnostic] Active Cloud Run ADC Identity: ${await res.text()}`);
    } else {
      console.log(`[Diagnostic] Failed to read metadata server: ${res.status}`);
    }
  } catch (e: any) {
    console.log(`[Diagnostic] Not on Cloud Run or metadata server unreachable (${e.message})`);
  }
}
printDiagnosticIdentity().catch(() => {});

//
// ─── Regional availability (v3.5 GLOBAL-FIX) ────────────────────────────────
// Both preview models (gemini-3-pro-image-preview and
// gemini-3.1-flash-image-preview) are ONLY served by the `global` Vertex
// endpoint. All regional endpoints return 404. The GA
// gemini-2.5-flash-image model still works regionally, but since we route
// everything through preview models now we hardcode `global` and treat
// regional values as legacy overrides.
const VERTEX_AI_REGION_ALLOWLIST = new Set<string>([
  'global',       // REQUIRED for preview models (gemini-3-pro, gemini-3.1-flash)
  'europe-west4',
  'europe-west1',
  'us-central1',
]);
const VERTEX_AI_DEFAULT_REGION = 'global';
// Preview models MUST use `global`. Used to override VERTEX_LOCATION when
// the resolved location is a regional one but the model is preview.
const VERTEX_AI_PREVIEW_LOCATION = 'global';

function resolveVertexLocation(): string {
  const raw = (process.env.VERTEX_AI_LOCATION || process.env.VERTEX_LOCATION || '').trim();

  if (!raw) {
    console.log(`[ai] VERTEX_AI_LOCATION unset → using default ${VERTEX_AI_DEFAULT_REGION}`);
    return VERTEX_AI_DEFAULT_REGION;
  }

  if (!VERTEX_AI_REGION_ALLOWLIST.has(raw)) {
    console.warn(
      `[ai] VERTEX_AI_LOCATION='${raw}' is not in the allow-list ` +
      `(${[...VERTEX_AI_REGION_ALLOWLIST].join(', ')}). Falling back to ${VERTEX_AI_DEFAULT_REGION}.`
    );
    return VERTEX_AI_DEFAULT_REGION;
  }

  return raw;
}

// [v3.5-GLOBAL-FIX] ACTIVE REGION: resolve from environment (prefer global)
const VERTEX_LOCATION = resolveVertexLocation();
console.log(`[ai] [v3.5-GLOBAL-FIX] ACTIVE REGION: ${VERTEX_LOCATION}`);

// Project ID for ADC (Application Default Credentials) mode. When Cloud Run
// runs us without service-account JSON keys in ./keys, we must still tell the
// SDK which GCP project to bill / hit. The SDK will NOT infer this from ADC
// alone when vertexai=true — leaving it blank silently falls back to AI Studio.
const VERTEX_ADC_PROJECT = process.env.GOOGLE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '';

interface KeySlot {
  keyPath: string;
  projectId: string;   // cached at pool init, avoids repeated JSON reads
  keyHint: string;
  cooldownUntil: number;
  /** True for the ADC slot. Used to suppress 24h cooldowns that would
   *  permanently brick the only available slot on a single Cloud Run service
   *  account — the real fix for those is always an IAM/role change, never a
   *  time-based retry. */
  isAdc: boolean;
}

const KEY_COOLDOWN_MS = 60_000; // cooldown 60s after a 429

function buildKeyPool(): KeySlot[] {
  const keysDir = path.resolve(process.cwd(), 'keys');
  console.log(`[KeyPool] Scanning ${keysDir}... (vertex location=${VERTEX_LOCATION}, adc_project=${VERTEX_ADC_PROJECT || '(unset)'})`);

  if (!fs.existsSync(keysDir)) {
    console.warn("[KeyPool] keys folder does not exist — using ADC slot");
    return [{ keyPath: "", projectId: VERTEX_ADC_PROJECT, keyHint: "adc", cooldownUntil: 0, isAdc: true }];
  }

  const files = fs.readdirSync(keysDir);
  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== 'dummy.json');

  if (jsonFiles.length === 0) {
    console.warn("[KeyPool] No JSON keys found — using ADC slot");
    return [{ keyPath: "", projectId: VERTEX_ADC_PROJECT, keyHint: "adc", cooldownUntil: 0, isAdc: true }];
  }

  console.log(`[KeyPool] Found ${jsonFiles.length} JSON key(s) in ./keys`);

  return jsonFiles.map(filename => {
    const keyPath = path.join(keysDir, filename);
    const keyContent = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
    const projectId = keyContent.project_id || 'unknown';
    return { keyPath, projectId, keyHint: filename.slice(-6), cooldownUntil: 0, isAdc: false };
  });
}

/**
 * Creates a fresh GoogleGenAI client bound to a disposable AbortController.
 *
 * Both service-account-JSON and ADC paths MUST pass `{ vertexai: true, project,
 * location }` explicitly. Without those flags @google/genai treats the client
 * as an AI Studio (Gemini API) client and demands an API key — on Cloud Run
 * that produces a permanent 403 that was previously misclassified as a
 * "key exhausted" 24h cooldown on the only ADC slot. That is the Phase 2
 * regression this refactor fixes.
 */
function createEphemeralClient(slot: KeySlot, signal: AbortSignal, locationOverride?: string, apiVersionOverride?: string): GoogleGenAI {
  const targetLocation = locationOverride || VERTEX_LOCATION;
  const targetApiVersion = apiVersionOverride || 'v1';
  const opts: Record<string, any> = {
    httpOptions: { signal },
    vertexai: true,
    location: targetLocation,
    apiVersion: targetApiVersion,
  };

  if (slot.keyPath) {
    // Service-account key path: temporarily set GOOGLE_APPLICATION_CREDENTIALS
    // so the underlying google-auth-library picks it up during token issue.
    const prev = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = slot.keyPath;
    opts.project = slot.projectId;
    console.log(`[Diagnostic] [v3.4-PRO-FIX] createEphemeralClient (JSON key ${slot.keyHint}): using project='${opts.project}', location='${targetLocation}', apiVersion='${targetApiVersion}'`);
    const client = new GoogleGenAI(opts);
    if (prev !== undefined) {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = prev;
    } else {
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    return client;
  }

  // ADC path: the SDK will use the Cloud Run service account via metadata
  // server. We MUST hand it an explicit project — ADC does not always carry a
  // quota project, and Vertex AI rejects requests without one.
  if (!VERTEX_ADC_PROJECT) {
    throw new Error(
      '[ai] ADC mode requires GOOGLE_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) env var. ' +
      'Set it to the GCP project that hosts Vertex AI for this service.'
    );
  }
  opts.project = VERTEX_ADC_PROJECT;
  console.log(`[Diagnostic] [v3.4-PRO-FIX] createEphemeralClient (ADC): using project='${opts.project}', location='${targetLocation}', apiVersion='${targetApiVersion}'`);
  return new GoogleGenAI(opts);
}

const keyPool: KeySlot[] = buildKeyPool();
let keyIndex = 0;

async function getNextClient(): Promise<KeySlot> {
  const now = Date.now();
  const total = keyPool.length;

  for (let i = 0; i < total; i++) {
    const slot = keyPool[(keyIndex + i) % total];
    if (slot.cooldownUntil <= now) {
      keyIndex = ((keyIndex + i) + 1) % total;
      return slot;
    }
  }

  // All keys in cooldown — wait for the earliest to become ready
  const earliest = keyPool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b);
  const waitMs = earliest.cooldownUntil - now;
  const waitSec = Math.ceil(waitMs / 1000);
  console.warn(`[KeyPool] All ${total} key(s) cooling. Waiting ${waitSec}s for key ...${earliest.keyHint}`);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  keyIndex = (keyPool.findIndex(s => s === earliest) + 1) % total;
  return earliest;
}

function markKeyCooldown(slot: KeySlot): void {
  slot.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  const ready = keyPool.filter(k => k.cooldownUntil <= Date.now()).length;
  console.warn(`[KeyPool] Key ...${slot.keyHint} → cooldown 60s | ${ready}/${keyPool.length} key(s) still ready`);
}

/**
 * 24h cooldown is only meaningful for rotatable JSON keys. For ADC there is
 * nothing to rotate — a 24h cooldown on the single ADC slot is self-inflicted
 * downtime. For ADC we log loudly and let the caller surface a clear IAM
 * error; the operator can fix roles and retry immediately instead of waiting.
 */
function markKey24hCooldown(slot: KeySlot, reason: string): boolean {
  if (slot.isAdc) {
    console.error(
      `[IAM FATAL] ${reason} on ADC slot — refusing to cool down ADC for 24h. ` +
      `Root cause is an IAM/config issue, not a quota. Required: ` +
      `(1) enable aiplatform.googleapis.com in project ${slot.projectId || '(unset)'} ` +
      `(2) grant 'roles/aiplatform.user' to the Cloud Run service account ` +
      `(3) verify GOOGLE_PROJECT_ID and VERTEX_AI_LOCATION env vars.`
    );
    return false; // caller should NOT set isKeyExhausted
  }
  slot.cooldownUntil = Date.now() + 24 * 60 * 60 * 1000;
  console.error(`[KeyPool] Key ...${slot.keyHint} → 24h cooldown (${reason})`);
  return true;
}

/**
 * Classifies an error from Vertex AI into actionable categories.
 */
function classifyError(err: any, errMsg: string, errDetails: any[], errBlob: string): {
  isBilling: boolean;
  isModelPermission: boolean;
  is429: boolean;
  isNotFound: boolean;
} {
  let parsedError: any = null;
  try { parsedError = JSON.parse(errMsg); } catch {}

  const isBilling =
    /billing|project_disabled|account_disabled|enable billing/i.test(errBlob) ||
    errDetails.some((d: any) => d?.reason === "BILLING_DISABLED") ||
    (parsedError?.error?.details?.some?.((d: any) => d?.reason === "BILLING_DISABLED")) ||
    (err?.error?.details?.some?.((d: any) => d?.reason === "BILLING_DISABLED"));

  const isModelPermission = !isBilling && (
    /iam_permission_denied|permission_denied/i.test(errBlob) ||
    err?.status === 403 ||
    err?.status === "PERMISSION_DENIED" ||
    err?.error?.code === 403 ||
    parsedError?.error?.code === 403 ||
    errDetails.some((d: any) => d?.reason === "IAM_PERMISSION_DENIED") ||
    (parsedError?.error?.details?.some?.((d: any) => d?.reason === "IAM_PERMISSION_DENIED")) ||
    (err?.error?.details?.some?.((d: any) => d?.reason === "IAM_PERMISSION_DENIED"))
  );

  const is429 = err?.status === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED");
  
  const isNotFound = err?.status === 404 || err?.status === "NOT_FOUND" || errMsg.includes("404") || errMsg.includes("NOT_FOUND") || parsedError?.error?.status === "NOT_FOUND";

  return { isBilling, isModelPermission, is429, isNotFound };
}

// Safety settings: minimize blocking for real face generation
const SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

export class VertexAIProvider implements IGenerationProvider {

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium' = 'premium', additionalImages?: string[]): Promise<string> {
    const operation = async () => {
      const slot = await getNextClient();
      const ready = keyPool.filter(k => k.cooldownUntil <= Date.now()).length;
      console.log(`[KeyPool] Using key ...${slot.keyHint} | ${ready}/${keyPool.length} ready`);
      // Use v1beta1 for premium if needed, or stick to v1 by default
      const apiVersion = process.env.VERTEX_AI_API_VERSION || 'v1';
      return this._generate(slot, originalImageBase64, mimeType, prompt, mode, additionalImages, apiVersion);
    };

    try {
      return await withExponentialBackoff(operation, "VertexAI.generateImage");
    } catch (error: any) {
      console.error("Vertex AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image via Vertex AI");
    }
  }

  private async _callModel(slot: KeySlot, modelId: string, contents: any[], mode: 'preview' | 'premium', locationOverride?: string, apiVersionOverride?: string): Promise<string> {
    const timeoutMs = MODEL_CALL_TIMEOUT_MS[modelId] ?? DEFAULT_CALL_TIMEOUT_MS;
    const timeoutSec = Math.round(timeoutMs / 1000);

    // Disposable AbortController: abort() actually closes the underlying TCP
    // socket because the signal is wired into the GoogleGenAI client at
    // construction time (httpOptions.signal). This is the only reliable way
    // to prevent dangling connections with @google/genai SDK.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const targetApiVersion = apiVersionOverride || process.env.VERTEX_AI_API_VERSION || 'v1';
      const client = createEphemeralClient(slot, controller.signal, locationOverride, targetApiVersion);

      const response = await client.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore
          responseModalities: ["IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature: mode === 'premium' ? 0.2 : 0.4,
          topP: mode === 'premium' ? 0.9 : 0.95,
        },
      } as any);

      clearTimeout(timeoutId);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return part.inlineData.data!;
        }
      }
      throw new Error(`No image data returned from ${modelId}`);

    } catch (err: any) {
      clearTimeout(timeoutId);
      // DIAGNOSTIC: Log the exact error payload from Vertex AI
      console.log(`[Diagnostic] [v3.4-PRO-FIX] Vertex AI _callModel Error for ${modelId} in ${locationOverride || VERTEX_LOCATION}:`);
      console.log(`  - message: ${err?.message}`);
      const reason = err?.reason || err?.error?.reason || (err?.details && err?.details[0]?.reason);
      console.log(`  - reason: ${reason}`);
      console.log(`  - status/code: ${err?.status} / ${err?.code || err?.error?.code}`);
      
      try {
        console.log(`  - raw object:`, JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
      } catch (e) {
        console.log(`  - raw object: [Stringify Failed] ${String(err)}`);
      }

      // AbortError = our timeout fired — translate to a recognisable isTimeout error
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        throw Object.assign(
          new Error(`[TIMEOUT] ${modelId} did not respond in ${timeoutSec}s`),
          { isTimeout: true }
        );
      }
      throw err;
    }
  }

  /**
   * v3.4 PRO-FIX: No cross-region fallback. Quota is strictly region-bound.
   * If the configured region fails, there is no reason to believe another
   * region will succeed (different quota, different IAM, different model
   * availability). Surface the error so the caller sees the real failure.
   */
  private async _callModelNoFallback(slot: KeySlot, modelId: string, contents: any[], mode: 'preview' | 'premium', apiVersion?: string): Promise<string> {
    return this._callModel(slot, modelId, contents, mode, VERTEX_LOCATION, apiVersion);
  }

  private async _generate(slot: KeySlot, originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium', additionalImages?: string[], apiVersion?: string): Promise<string> {
    const tier = mode === 'premium' ? 'PREMIUM' : 'FREE';

    // Build multimodal contents
    const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
    const contents: any[] = [];
    contents.push({ inlineData: { data: originalImageBase64, mimeType } });
    if (additionalImages && additionalImages.length > 0 && (mode === 'premium' || FREE_V2)) {
      for (const img of additionalImages) {
        contents.push({ inlineData: { data: img, mimeType } });
      }
    }
    contents.push({ text: prompt });

    // ─── L1 ONLY (tier-based Gemini; no Imagen fallback) ───────────────────
    // Imagen fallbacks were removed in v3.4 — they were throwing 500s and
    // "fetch failed (other side closed)" which crashed the event loop and
    // triggered SIGTERM on Cloud Run. Fail fast instead.
    const l1Model = mode === 'premium' ? PRO_MODEL_PRIMARY : FREE_MODEL_PRIMARY;

    // Preview models (gemini-3-pro-image-preview, gemini-3.1-flash-image-preview)
    // REQUIRE v1beta1 and location=global on Vertex AI. Verified via probe
    // on 2026-04-21 — regional endpoints return 404 for preview models.
    // Non-preview GA models keep v1 and the configured regional location.
    const isPreviewModel = l1Model.includes('preview');
    const envApiVersion = (process.env.VERTEX_AI_API_VERSION || '').trim();
    const effectiveApiVersion = envApiVersion
      ? envApiVersion
      : (isPreviewModel ? 'v1beta1' : (apiVersion || 'v1'));
    const effectiveLocation = isPreviewModel ? VERTEX_AI_PREVIEW_LOCATION : VERTEX_LOCATION;

    console.log(`[v3.6-HARDEN] [Tier: ${tier}] L1 → ${l1Model} (${effectiveApiVersion}) | region=${effectiveLocation} | key ...${slot.keyHint}`);

    try {
      // v3.6: Wrap in withNetworkRetry to absorb transient Vertex transport
      // failures (fetch failed / other side closed / 500 / 503 / socket hang
      // up). Two retries, 10s apart. The underlying AbortController timeout
      // still fires at MODEL_CALL_TIMEOUT_MS per attempt, so worst-case
      // latency per image is bounded by ~3 * 120s + 2 * 10s = 380s on Pro.
      const result = await withNetworkRetry(
        () => this._callModel(slot, l1Model, contents, mode, effectiveLocation, effectiveApiVersion),
        `L1 ${l1Model}@${effectiveLocation}`,
      );
      console.log(`[v3.6-HARDEN] L1 SUCCESS | model=${l1Model}@${effectiveLocation}`);
      return result;
    } catch (l1Err: any) {
      const l1Msg = l1Err?.message || "";
      const l1Cls = classifyError(l1Err, l1Msg, l1Err?.details || [], [l1Msg, stringifyErrorDetails(l1Err)].join(" "));

      // 429/billing short-circuit: apply cooldowns (for key rotation / retry policy)
      if (l1Cls.isBilling) markKey24hCooldown(slot, 'L1 billing disabled');
      else if (l1Cls.is429) markKeyCooldown(slot);

      console.error(`[v3.5-GLOBAL-FIX] L1 ${l1Model} FATAL in ${effectiveLocation} (${l1Msg.slice(0, 200)})`);
      throw new Error(`[v3.5] Generation failed on ${l1Model}@${effectiveLocation}: ${l1Msg.slice(0, 150)}`);
    }
  }
}

export class GeminiProvider implements IGenerationProvider {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium' = 'premium', additionalImages?: string[]): Promise<string> {
    const operation = async () => {
      const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
      const contents: any[] = [];
      contents.push({ inlineData: { data: originalImageBase64, mimeType } });
      // Defense-in-depth: only pass additional refs when explicitly expected
      if (additionalImages && additionalImages.length > 0 && (mode === 'premium' || FREE_V2)) {
        for (const img of additionalImages) {
          contents.push({ inlineData: { data: img, mimeType } });
        }
      }
      contents.push({ text: prompt });

      const modelId = mode === 'premium' ? PRO_MODEL_PRIMARY : FREE_MODEL_PRIMARY;
      const response = await this.ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore
          responseModalities: ["TEXT", "IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature: mode === 'premium' ? 0.2 : 0.4,
          topP: mode === 'premium' ? 0.9 : 0.95,
        },
      } as any);

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) return part.inlineData.data;
      }
      throw new Error(`No image data returned from model (${modelId})`);
    };

    try {
      return await withExponentialBackoff(operation, "Gemini.generateImage");
    } catch (error: any) {
      console.error("AI Generation Error:", error);
      throw new Error(error.message || "Failed to generate image");
    }
  }
}

const useVertex = process.env.USE_VERTEX_AI === "true";
export const aiProvider: IGenerationProvider = useVertex ? new VertexAIProvider() : new GeminiProvider();
