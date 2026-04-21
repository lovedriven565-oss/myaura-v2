import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode?: 'preview' | 'premium', additionalImages?: string[]): Promise<string>;
}

// ─── MyAURA Model Stack (Vertex AI) ─────────────────────────────────────────
// v4.0 UNIFIED FLASH PIVOT (2026-04-21):
//   gemini-3-pro-image-preview was producing plastic/CGI faces regardless of
//   prompt architecture (V10 sentence blocks, V11 tag cascade). It is REMOVED.
//   Both tiers now route through gemini-3.1-flash-image-preview on the Vertex
//   AI `global` endpoint with apiVersion `v1beta1`. Regional endpoints
//   return 404 for preview models — verified 2026-04-21.
//
//   Tier differentiation lives in OUTPUT VOLUME, EXCLUSIVE STYLES, REFERENCE
//   DEPTH, and TEMPERATURE — NOT in model choice.
const UNIFIED_MODEL = "gemini-3.1-flash-image-preview";
const IMAGEN_3_GENERATE_MODEL = "imagen-3.0-generate-001";
// v5.0: Use proven generate-001 model with Subject Customization fields.
// capability-001 does not exist on any endpoint (404 confirmed).
const IMAGEN_3_SUBJECT_MODEL = process.env.IMAGEN_3_SUBJECT_MODEL || "imagen-3.0-generate-001";

// ─── v5.0 Instant Tuning / Subject Customization Feature Flags ──────────────
//   Vertex AI "Instant Tuning" for Imagen 3 is an experimental pipeline.
//   When enabled, Premium tier attempts to create a lightweight subject adapter
//   via a Vertex AI CustomJob, then generates through the tuned endpoint.
//   If tuning fails or is disabled, we fall back to inference-time Subject
//   Customization on the capability model (the Google-documented path).
const VERTEX_AI_TUNING_ENABLED = process.env.VERTEX_AI_TUNING_ENABLED === "true";
const VERTEX_AI_TUNING_CONTAINER_IMAGE = process.env.VERTEX_AI_TUNING_CONTAINER_IMAGE || "";
const VERTEX_AI_TUNING_ARGS_JSON = process.env.VERTEX_AI_TUNING_ARGS_JSON || "[]";
const VERTEX_AI_TUNING_MACHINE_TYPE = process.env.VERTEX_AI_TUNING_MACHINE_TYPE || "n1-standard-4";
const VERTEX_AI_TUNING_MAX_WAIT_MS = parseInt(process.env.VERTEX_AI_TUNING_MAX_WAIT_MS || "900000", 10); // 15 min
const VERTEX_AI_TUNING_POLL_INTERVAL_MS = parseInt(process.env.VERTEX_AI_TUNING_POLL_INTERVAL_MS || "15000", 10); // 15s

// Retry configuration for resilience against 429 rate limits
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 15000; // 15s base
const MAX_DELAY_MS = 60000;  // cap at 60s

// Per-model call timeout. Keyed on model ID so future variants (Pro, 3.x)
// pick up their own values once added. Unknown models fall back to DEFAULT.
const MODEL_CALL_TIMEOUT_MS: Record<string, number> = {
  ["gemini-2.5-flash-image"]:          90_000,
  ["gemini-3.1-flash-image-preview"]:  90_000,
  [IMAGEN_3_SUBJECT_MODEL]:          120_000, // Subject Customization is heavier
};
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

// v5.0: Tuned-model inference may have cold-start latency.
const TUNED_MODEL_CALL_TIMEOUT_MS = parseInt(process.env.TUNED_MODEL_TIMEOUT_MS || "180000", 10);

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

// Concurrency-safe key-selection lock. p-queue may run >1 task in parallel,
// so we must serialise slot picking to prevent two workers grabbing the
// same keyIndex and hammering the same GCP project / quota bucket.
let _keySelectPromise: Promise<void> = Promise.resolve();

function acquireKeyLock(): Promise<() => void> {
  let release: () => void;
  const p = new Promise<void>(resolve => { release = resolve; });
  const prev = _keySelectPromise;
  _keySelectPromise = prev.then(() => p);
  return prev.then(() => release);
}

async function getNextClient(): Promise<KeySlot> {
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

    // All keys in cooldown — wait for the earliest to become ready
    const earliest = keyPool.reduce((a, b) => a.cooldownUntil < b.cooldownUntil ? a : b);
    const waitMs = earliest.cooldownUntil - now;
    const waitSec = Math.ceil(waitMs / 1000);
    console.warn(`[KeyPool] All ${total} key(s) cooling. Waiting ${waitSec}s for key ...${earliest.keyHint}`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    keyIndex = (keyPool.findIndex(s => s === earliest) + 1) % total;
    return earliest;
  } finally {
    unlock();
  }
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
          temperature: mode === 'premium' ? 0.1 : 0.4,
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

  /**
   * v5.0 IMAGEN-3 SUBJECT CUSTOMIZATION: Proper inference-time subject preservation
   * using imagen-3.0-capability-001 with subjectImageConfig + subjectDescription.
   *
   * Key differences from v4.1:
   *   - Uses imagen-3.0-capability-001 (the model that supports Subject Customization)
   *   - subjectImageConfig.subjectDescription anchors the model to the reference face
   *   - Prompt includes [1] token so the model binds the reference image to the person
   *   - Optional face-mesh CONTROL reference (same image) to lock facial geometry
   *   - Falls back to flash model on any error.
   */
  private async _callImagen3SubjectCustomization(
    slot: KeySlot,
    prompt: string,
    originalImageBase64: string,
    mimeType: string,
    additionalImages?: string[],
  ): Promise<string> {
    const { GoogleAuth } = await import('google-auth-library');

    const auth = new GoogleAuth({
      keyFile: slot.isAdc ? undefined : slot.keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: slot.projectId || VERTEX_ADC_PROJECT,
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // v5.0-FIX: Imagen 3 predict endpoint requires a regional location.
    // Default to us-central1 (confirmed working for generate-001).
    const IMAGEN3_SUBJECT_LOCATION = process.env.VERTEX_AI_IMAGEN3_LOCATION || 'us-central1';
    const location = IMAGEN3_SUBJECT_LOCATION;
    // v5.0: Subject Customization is on v1beta1 (preview API)
    const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${slot.projectId || VERTEX_ADC_PROJECT}/locations/${location}/publishers/google/models/${IMAGEN_3_SUBJECT_MODEL}:predict`;
    console.log(`[v5.0-IMAGEN3-SUBJ] Predict URL: ${url}`);

    // ── Reference images ──────────────────────────────────────────────────
    // Primary subject reference (referenceId: 1) — the face we want to preserve
    const referenceImages: any[] = [{
      referenceType: "REFERENCE_TYPE_SUBJECT",
      referenceId: 1,
      referenceImage: {
        bytesBase64Encoded: originalImageBase64,
        mimeType,
      },
      subjectImageConfig: {
        subjectDescription: "professional headshot portrait with exact haircut geometry, natural receding hairline, un-retouched skin texture, and original jawline",
        subjectType: "SUBJECT_TYPE_PERSON",
      },
    }];

    // Face-mesh control reference (referenceId: 2) — same image, used to lock facial geometry.
    // This prevents the model from altering jawline, chin, or face width.
    referenceImages.push({
      referenceType: "REFERENCE_TYPE_CONTROL",
      referenceId: 2,
      referenceImage: {
        bytesBase64Encoded: originalImageBase64,
        mimeType,
      },
      controlImageConfig: {
        controlType: "CONTROL_TYPE_FACE_MESH",
        enableControlImageComputation: true,
      },
    });

    // Additional reference images as extra subject anchors (referenceId: 3+)
    if (additionalImages && additionalImages.length > 0) {
      additionalImages.forEach((img, idx) => {
        referenceImages.push({
          referenceType: "REFERENCE_TYPE_SUBJECT",
          referenceId: idx + 3,
          referenceImage: {
            bytesBase64Encoded: img,
            mimeType,
          },
          subjectImageConfig: {
            subjectDescription: "additional angle of the same person, same haircut and facial features",
            subjectType: "SUBJECT_TYPE_PERSON",
          },
        });
      });
    }

    const body = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "9:16",
        personGeneration: "allow_all",
        referenceImages,
      },
    };

    const fetch = (await import('node-fetch')).default || globalThis.fetch;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[v5.0-IMAGEN3-SUBJ] HTTP ${response.status} from ${url}: ${errorText.slice(0, 800)}`);
      throw new Error(`Imagen 3 Subject Customization predict failed: ${response.status} ${errorText.slice(0, 400)}`);
    }

    const data = await response.json() as any;
    const predictions = data.predictions || [];
    if (predictions.length === 0) {
      throw new Error('Imagen 3 Subject Customization returned no predictions');
    }

    const imageData = predictions[0]?.bytesBase64Encoded;
    if (!imageData) {
      throw new Error('Imagen 3 Subject Customization prediction missing image data');
    }
    return imageData;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // ─── EXPERIMENTAL: Vertex AI Instant Tuning Pipeline (v5.0) ─────────────────
  // ═════════════════════════════════════════════════════════════════════════════
  //
  // NOTE: This pipeline attempts to create a Vertex AI CustomJob that runs an
  // "Instant Tuning" container for Imagen 3, producing a tuned model/adapter.
  // It is EXPERIMENTAL and gated by VERTEX_AI_TUNING_ENABLED.
  //
  // Required environment variables (when enabled):
  //   VERTEX_AI_TUNING_CONTAINER_IMAGE — GCR image URI for the tuning container
  //   VERTEX_AI_TUNING_ARGS_JSON       — JSON array of container arguments
  //
  // If tuning fails at any step, we immediately fall back to inference-time
  // Subject Customization (imagen-3.0-capability-001) which is the Google-
  // documented path and requires no training job.
  // ═════════════════════════════════════════════════════════════════════════════

  private async _createInstantTuningJob(
    slot: KeySlot,
    _originalImageBase64: string,
    _mimeType: string,
    _additionalImages?: string[],
  ): Promise<string> {
    if (!VERTEX_AI_TUNING_CONTAINER_IMAGE) {
      throw new Error('VERTEX_AI_TUNING_CONTAINER_IMAGE is not configured');
    }

    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: slot.isAdc ? undefined : slot.keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: slot.projectId || VERTEX_ADC_PROJECT,
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const location = VERTEX_LOCATION === 'global' ? 'us-central1' : VERTEX_LOCATION;
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${slot.projectId || VERTEX_ADC_PROJECT}/locations/${location}/customJobs`;

    const displayName = `myaura-instant-tuning-${Date.now()}`;
    let containerArgs: string[] = [];
    try {
      containerArgs = JSON.parse(VERTEX_AI_TUNING_ARGS_JSON);
    } catch {
      console.warn('[v5.0-Tuning] VERTEX_AI_TUNING_ARGS_JSON is not valid JSON, using empty args');
    }

    const body = {
      displayName,
      jobSpec: {
        workerPoolSpecs: [{
          machineSpec: { machineType: VERTEX_AI_TUNING_MACHINE_TYPE },
          containerSpec: {
            imageUri: VERTEX_AI_TUNING_CONTAINER_IMAGE,
            args: containerArgs,
          },
        }],
      },
    };

    const fetch = (await import('node-fetch')).default || globalThis.fetch;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tuning job creation failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as any;
    const jobName = data.name; // e.g. projects/.../locations/.../customJobs/123
    console.log(`[v5.0-Tuning] Created CustomJob: ${jobName}`);
    return jobName;
  }

  private async _pollTuningJob(
    slot: KeySlot,
    jobName: string,
  ): Promise<{ modelName?: string; endpointName?: string } | null> {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: slot.isAdc ? undefined : slot.keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: slot.projectId || VERTEX_ADC_PROJECT,
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://us-central1-aiplatform.googleapis.com/v1/${jobName}`;
    const fetch = (await import('node-fetch')).default || globalThis.fetch;

    const startedAt = Date.now();
    while (Date.now() - startedAt < VERTEX_AI_TUNING_MAX_WAIT_MS) {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Tuning job poll failed: ${response.status} ${text}`);
      }

      const data = await response.json() as any;
      const state = data.state;
      console.log(`[v5.0-Tuning] Job ${jobName} state=${state} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);

      if (state === 'JOB_STATE_SUCCEEDED') {
        // Extract model / endpoint from job output if available
        const modelName = data.jobSpec?.workerPoolSpecs?.[0]?.containerSpec?.args
          ?.find((a: string) => a.startsWith('--output_model='))
          ?.replace('--output_model=', '')
          || data.modelName;
        return { modelName, endpointName: data.endpointName };
      }

      if (state === 'JOB_STATE_FAILED' || state === 'JOB_STATE_CANCELLED') {
        throw new Error(`Tuning job ${jobName} ended with state=${state}`);
      }

      await new Promise(r => setTimeout(r, VERTEX_AI_TUNING_POLL_INTERVAL_MS));
    }

    throw new Error(`Tuning job ${jobName} did not complete within ${VERTEX_AI_TUNING_MAX_WAIT_MS}ms`);
  }

  private async _generateWithTunedModel(
    slot: KeySlot,
    prompt: string,
    endpointName: string,
  ): Promise<string> {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: slot.isAdc ? undefined : slot.keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: slot.projectId || VERTEX_ADC_PROJECT,
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://us-central1-aiplatform.googleapis.com/v1/${endpointName}:predict`;
    const body = {
      instances: [{ prompt }],
      parameters: { sampleCount: 1, aspectRatio: "9:16" },
    };

    const fetch = (await import('node-fetch')).default || globalThis.fetch;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TUNED_MODEL_CALL_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tuned model predict failed: ${response.status} ${errorText}`);
      }

      const data = await response.json() as any;
      const predictions = data.predictions || [];
      if (predictions.length === 0) {
        throw new Error('Tuned model returned no predictions');
      }
      return predictions[0]?.bytesBase64Encoded;
    } catch (err: any) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private async _cleanupTunedModel(
    slot: KeySlot,
    modelName?: string,
    endpointName?: string,
  ): Promise<void> {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: slot.isAdc ? undefined : slot.keyPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      projectId: slot.projectId || VERTEX_ADC_PROJECT,
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const fetch = (await import('node-fetch')).default || globalThis.fetch;

    if (endpointName) {
      try {
        await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${endpointName}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        console.log(`[v5.0-Tuning] Cleaned up endpoint: ${endpointName}`);
      } catch (e: any) {
        console.warn(`[v5.0-Tuning] Endpoint cleanup failed: ${e.message}`);
      }
    }
    if (modelName) {
      try {
        await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${modelName}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        console.log(`[v5.0-Tuning] Cleaned up model: ${modelName}`);
      } catch (e: any) {
        console.warn(`[v5.0-Tuning] Model cleanup failed: ${e.message}`);
      }
    }
  }

  /**
   * v5.0 PREMIUM PIPELINE:
   *   1. EXPERIMENTAL: If VERTEX_AI_TUNING_ENABLED, attempt Instant Tuning
   *      (CustomJob → poll → generate with tuned endpoint → cleanup).
   *   2. PRIMARY: Imagen 3 Subject Customization (imagen-3.0-generate-001)
   *      with subjectImageConfig + face-mesh CONTROL reference.
   *   3. FALLBACK: Unified flash model (gemini-3.1-flash-image-preview).
   *
   * Free tier skips all of the above and goes straight to flash.
   */
  private async _generate(
    slot: KeySlot,
    originalImageBase64: string,
    mimeType: string,
    prompt: string,
    mode: 'preview' | 'premium',
    additionalImages?: string[],
    apiVersion?: string,
  ): Promise<string> {
    const tier = mode === 'premium' ? 'PREMIUM' : 'FREE';

    // ─── Premium: attempt experimental tuning pipeline first ─────────────────
    if (mode === 'premium' && VERTEX_AI_TUNING_ENABLED) {
      console.log(`[v5.0-TUNING] [Tier: PREMIUM] Attempting Instant Tuning pipeline | key ...${slot.keyHint}`);
      let tuningJobName: string | undefined;
      let tunedModelName: string | undefined;
      let tunedEndpointName: string | undefined;

      try {
        tuningJobName = await this._createInstantTuningJob(slot, originalImageBase64, mimeType, additionalImages);
        const tuned = await this._pollTuningJob(slot, tuningJobName);
        if (!tuned?.endpointName) {
          throw new Error('Tuning completed but no endpoint was produced');
        }
        tunedModelName = tuned.modelName;
        tunedEndpointName = tuned.endpointName;

        console.log(`[v5.0-TUNING] Tuning complete. endpoint=${tunedEndpointName} model=${tunedModelName}`);
        const result = await withNetworkRetry(
          () => this._generateWithTunedModel(slot, prompt, tunedEndpointName!),
          `TunedModel@${tunedEndpointName}`,
        );
        console.log(`[v5.0-TUNING] SUCCESS → image returned`);
        return result;
      } catch (tuningErr: any) {
        console.warn(`[v5.0-TUNING] Tuning pipeline failed: ${tuningErr.message}. Falling back to Subject Customization.`);
      } finally {
        if (tuningJobName) {
          this._cleanupTunedModel(slot, tunedModelName, tunedEndpointName).catch(() => {});
        }
      }
    }

    // ─── Premium: Imagen 3 Subject Customization (primary path) ──────────────
    if (mode === 'premium') {
      console.log(`[v5.0-IMAGEN3-SUBJ] [Tier: PREMIUM] Attempting ${IMAGEN_3_SUBJECT_MODEL} | key ...${slot.keyHint}`);
      try {
        const result = await withNetworkRetry(
          () => this._callImagen3SubjectCustomization(slot, prompt, originalImageBase64, mimeType, additionalImages),
          `Imagen3Subject@${VERTEX_LOCATION}`,
        );
        console.log(`[v5.0-IMAGEN3-SUBJ] SUCCESS → image returned`);
        return result;
      } catch (imagenErr: any) {
        const imagenMsg = imagenErr?.message || "";
        const imagenCls = classifyError(imagenErr, imagenMsg, imagenErr?.details || [], [imagenMsg, stringifyErrorDetails(imagenErr)].join(" "));

        if (imagenCls.isModelPermission || imagenCls.isNotFound || imagenCls.isBilling) {
          console.warn(`[v5.0-IMAGEN3-SUBJ] ${IMAGEN_3_SUBJECT_MODEL} unavailable (${imagenMsg.slice(0, 160)}). Falling back to flash.`);
        } else if (imagenCls.is429) {
          markKeyCooldown(slot);
          console.warn(`[v5.0-IMAGEN3-SUBJ] 429 on ${IMAGEN_3_SUBJECT_MODEL}. Falling back to flash.`);
        } else {
          console.warn(`[v5.0-IMAGEN3-SUBJ] ${IMAGEN_3_SUBJECT_MODEL} failed (${imagenMsg.slice(0, 160)}). Falling back to flash.`);
        }
        // Intentional fall-through to flash fallback below
      }
    }

    // Build multimodal contents for Gemini flash fallback
    const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
    const contents: any[] = [];
    contents.push({ inlineData: { data: originalImageBase64, mimeType } });
    if (additionalImages && additionalImages.length > 0 && (mode === 'premium' || FREE_V2)) {
      for (const img of additionalImages) {
        contents.push({ inlineData: { data: img, mimeType } });
      }
    }
    contents.push({ text: prompt });

    // ─── L1: unified flash model (free + premium fallback) ─────────────────
    const l1Model = UNIFIED_MODEL;
    const effectiveApiVersion = 'v1beta1';
    const effectiveLocation = VERTEX_AI_PREVIEW_LOCATION;

    console.log(`[v5.0-FLASH-FALLBACK] [Tier: ${tier}] L1 → ${l1Model} (${effectiveApiVersion}) | region=${effectiveLocation} | key ...${slot.keyHint}`);

    try {
      const result = await withNetworkRetry(
        () => this._callModel(slot, l1Model, contents, mode, effectiveLocation, effectiveApiVersion),
        `L1 ${l1Model}@${effectiveLocation}`,
      );
      console.log(`[v5.0-FLASH-FALLBACK] L1 SUCCESS | model=${l1Model}@${effectiveLocation}`);
      return result;
    } catch (l1Err: any) {
      const l1Msg = l1Err?.message || "";
      const l1Cls = classifyError(l1Err, l1Msg, l1Err?.details || [], [l1Msg, stringifyErrorDetails(l1Err)].join(" "));

      if (l1Cls.isBilling) markKey24hCooldown(slot, 'L1 billing disabled');
      else if (l1Cls.is429) markKeyCooldown(slot);

      console.error(`[v5.0-FLASH-FALLBACK] L1 ${l1Model} FATAL in ${effectiveLocation} (${l1Msg.slice(0, 200)})`);
      throw new Error(`[v5.0] Generation failed on ${l1Model}@${effectiveLocation}: ${l1Msg.slice(0, 150)}`);
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

      const modelId = UNIFIED_MODEL;
      const response = await this.ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          // @ts-ignore
          responseModalities: ["TEXT", "IMAGE"],
          safetySettings: SAFETY_SETTINGS,
          temperature: mode === 'premium' ? 0.1 : 0.4,
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
