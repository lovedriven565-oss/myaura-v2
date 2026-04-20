import { GoogleGenAI } from "@google/genai";
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import path from "path";

export interface IGenerationProvider {
  generateImage(originalImageBase64: string, mimeType: string, prompt: string, mode?: 'preview' | 'premium', additionalImages?: string[]): Promise<string>;
}

// ─── MyAURA Model Stack (Vertex AI) ─────────────────────────────────────────
// Confirmed via Vertex AI Model Garden screenshot (2026-04-20): the IDs
// "gemini-3.1-flash-image-preview" and "gemini-3-pro-image-preview" DO exist
// on Vertex AI. The 403 "may not exist" wording from the API is misleading —
// it fires for any combination of (model unavailable in region, project not
// allow-listed, missing IAM). The right region (europe-west4, see below)
// plus roles/aiplatform.user on the Cloud Run SA is what unlocks these.
//
// Model assignment:
//   FREE primary/fallback : gemini-3.1-flash-image-preview  (Nano Banana)
//   PRO  primary          : gemini-3-pro-image-preview      (higher quality)
//   PRO  fallback         : gemini-3.1-flash-image-preview  (graceful degrade)
//
// Env overrides remain, so operators can pin a specific variant without a
// redeploy. We use the SHORT model ID — @google/genai with `vertexai: true,
// project, location` auto-builds the full resource path
// `projects/.../locations/.../publishers/google/models/<id>` under the hood,
// so no manual path construction is needed.
// 2026-04-20 L1 BYPASS: gemini-3.1-flash-image-preview is 404 NOT_FOUND for
// this project in both europe-west4 AND us-central1 publisher registries,
// despite appearing in Model Garden. It's not allowlisted for our GCP org.
// Every L1 attempt burns ~15–30s (primary + regional fallback) before the
// system degrades to L2. Until Google unblocks the preview model, we skip
// it entirely and point everything at gemini-2.5-flash-image (confirmed
// working per logs). Env vars still win so re-enabling is a no-deploy config
// change when the 3.1 model goes GA.
const FREE_MODEL_PRIMARY   = process.env.VERTEX_AI_MODEL_FREE             || process.env.FREE_MODEL_ID             || "gemini-2.5-flash-image";
const FREE_MODEL_FALLBACK  = process.env.VERTEX_AI_MODEL_FREE_FALLBACK    || process.env.FREE_MODEL_FALLBACK_ID    || "gemini-2.5-flash-image";
const PRO_MODEL_PRIMARY    = process.env.VERTEX_AI_MODEL_PREMIUM          || process.env.PREMIUM_MODEL_ID          || "gemini-3-pro-image-preview";
const PRO_MODEL_FALLBACK   = process.env.VERTEX_AI_MODEL_PREMIUM_FALLBACK || process.env.PREMIUM_MODEL_FALLBACK_ID || "gemini-2.5-flash-image";

// Retry configuration for resilience against 429 rate limits
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 15000; // 15s base
const MAX_DELAY_MS = 60000;  // cap at 60s

// Per-model call timeout. Keyed on model ID so future variants (Pro, 3.x)
// pick up their own values once added. Unknown models fall back to DEFAULT.
const MODEL_CALL_TIMEOUT_MS: Record<string, number> = {
  ["gemini-2.5-flash-image-preview"]: 90_000,
  // Kept for forward-compat once Google ships these on Vertex AI:
  ["gemini-3.1-flash-image-preview"]: 90_000,
  ["gemini-3-pro-image-preview"]:    120_000,
};
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

function stringifyErrorDetails(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
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
// ─── Regional availability note (Phase 2 hotfix) ────────────────────────────
// Gemini image-preview models (gemini-3.1-flash-image-preview,
// gemini-3-pro-image-preview) are NOT published in europe-west1 — calls
// there return 403 "Permission denied or model may not exist", which we
// previously misdiagnosed as an IAM misconfiguration.
//
// The canonical region for this model family in the EU is europe-west4
// (Netherlands). We therefore:
//   1. Default to europe-west4 when no env var is set.
//   2. Honour VERTEX_AI_LOCATION (and legacy VERTEX_LOCATION) when it points
//      at a region we trust.
//   3. EXPLICITLY REMAP europe-west1 → europe-west4 with a warn-log, because
//      every current Cloud Run deploy has `VERTEX_AI_LOCATION=europe-west1`
//      baked in and flipping that env var cleanly requires a redeploy. This
//      override is the fast path; operators should still update the env var.
//
// If we ever need a different region (e.g. us-central1 for a new model), add
// it to the allow-list below rather than broadening the override.
const VERTEX_AI_REGION_ALLOWLIST = new Set<string>([
  'europe-west4', // canonical EU region for gemini-3.x image-preview models
  'us-central1',  // canonical US fallback — keep handy for emergencies
]);
const VERTEX_AI_DEFAULT_REGION = 'us-central1';

function resolveVertexLocation(): string {
  const raw = (process.env.VERTEX_AI_LOCATION || process.env.VERTEX_LOCATION || '').trim();

  if (!raw) {
    console.log(`[ai] VERTEX_AI_LOCATION unset → using default ${VERTEX_AI_DEFAULT_REGION}`);
    return VERTEX_AI_DEFAULT_REGION;
  }

  // Legacy env var still set to europe-west1: swap in code to avoid a redeploy
  // just to flip a string. Warn loudly so operators notice.
  if (raw === 'europe-west1' || raw === 'europe-west4') {
    console.warn(
      `[ai] VERTEX_AI_LOCATION=${raw} is overridden to ${VERTEX_AI_DEFAULT_REGION} for diagnostic purposes. ` +
      `Update the env var on Cloud Run to silence this warning.`
    );
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

// [v3.3-NANO-BANANA-ADMIN] ACTIVE REGION: us-central1 (Hard Override)
const VERTEX_LOCATION = "us-central1";
console.log(`[ai] [v3.3-NANO-BANANA-ADMIN] ACTIVE REGION: ${VERTEX_LOCATION}`);

// Verified Model IDs in us-central1 for this project:
const L1_PRIMARY_MODEL = "gemini-3.1-flash-image-preview";
const L2_STABILITY_MODEL = "gemini-2.5-flash-image";
const L3_SAFETY_NET_MODEL = "imagen-3.0-generate-001";

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
    console.log(`[Diagnostic] [v3.2-US-FIX] createEphemeralClient (JSON key ${slot.keyHint}): using project='${opts.project}', location='${targetLocation}'`);
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
  console.log(`[Diagnostic] [v3.2-US-FIX] createEphemeralClient (ADC): using project='${opts.project}', location='${targetLocation}'`);
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
      console.log(`[Diagnostic] [v3.2-US-FIX] Vertex AI _callModel Error for ${modelId} in ${locationOverride || VERTEX_LOCATION}:`);
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

  private async _callModelWithRegionFallback(slot: KeySlot, modelId: string, contents: any[], mode: 'preview' | 'premium', apiVersion?: string): Promise<string> {
    try {
      return await this._callModel(slot, modelId, contents, mode, VERTEX_LOCATION, apiVersion);
    } catch (err: any) {
      const errMsg: string = err?.message || "";
      const errDetails = err?.details || [];
      const errBlob = [errMsg, stringifyErrorDetails(errDetails), stringifyErrorDetails(err?.error), stringifyErrorDetails(err)].join(" ");
      const { isModelPermission } = classifyError(err, errMsg, errDetails, errBlob);

      // If we got a 403 on the primary region (e.g. europe-west4), try us-central1 as a last resort
      // before giving up to the fallback chain.
      if (isModelPermission && VERTEX_LOCATION !== 'us-central1') {
        console.warn(`[Region Fallback] 403 denied for ${modelId} in ${VERTEX_LOCATION}. Auto-retrying explicitly in us-central1...`);
        return await this._callModel(slot, modelId, contents, mode, 'us-central1', apiVersion);
      }

      throw err;
    }
  }

  /**
   * Call Imagen via the `:predict` endpoint. Imagen models are NOT accessible
   * via generateContent — they require the classic Vertex AI predict API with
   * an `instances` array.
   */
  private async _callImagenPredict(modelId: string, prompt: string, additionalImages?: string[]): Promise<string> {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const token = tokenRes.token;
    if (!token) throw new Error(`[Imagen] Failed to obtain access token for ${modelId}`);

    const project = VERTEX_ADC_PROJECT;
    if (!project) throw new Error(`[Imagen] VERTEX_ADC_PROJECT not set`);

    const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${VERTEX_LOCATION}/publishers/google/models/${modelId}:predict`;

    const body = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "1:1",
        safetyFilterLevel: "block_only_high",
        personGeneration: "allow_adult",
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CALL_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`[Imagen:predict] HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }

      const data: any = await res.json();
      const base64 = data?.predictions?.[0]?.bytesBase64Encoded;
      if (!base64) {
        throw new Error(`[Imagen:predict] No image in response: ${JSON.stringify(data).slice(0, 300)}`);
      }
      return base64;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        throw Object.assign(new Error(`[Imagen:predict TIMEOUT] ${modelId}`), { isTimeout: true });
      }
      throw err;
    }
  }

  private async _generate(slot: KeySlot, originalImageBase64: string, mimeType: string, prompt: string, mode: 'preview' | 'premium', additionalImages?: string[], apiVersion?: string): Promise<string> {
    const tier = mode === 'premium' ? 'PREMIUM' : 'FREE';

    // Build multimodal contents (L1 and L2 are Gemini models — accept image inputs + text prompt)
    const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";
    const contents: any[] = [];
    contents.push({ inlineData: { data: originalImageBase64, mimeType } });
    if (additionalImages && additionalImages.length > 0 && (mode === 'premium' || FREE_V2)) {
      for (const img of additionalImages) {
        contents.push({ inlineData: { data: img, mimeType } });
      }
    }
    contents.push({ text: prompt });

    // ─── L1: PRIMARY (Gemini 3.1 Flash Image) ─────────────────────────
    console.log(`[v3.3-NANO-BANANA-ADMIN] [Tier: ${tier}] L1 → ${L1_PRIMARY_MODEL} (${apiVersion || 'v1'}) | key ...${slot.keyHint}`);
    try {
      const result = await this._callModelWithRegionFallback(slot, L1_PRIMARY_MODEL, contents, mode, apiVersion);
      console.log(`[v3.3-NANO-BANANA-ADMIN] L1 SUCCESS | model=${L1_PRIMARY_MODEL}`);
      return result;
    } catch (l1Err: any) {
      const l1Msg = l1Err?.message || "";
      const l1Cls = classifyError(l1Err, l1Msg, l1Err?.details || [], [l1Msg, stringifyErrorDetails(l1Err)].join(" "));

      // 429/billing short-circuit: apply cooldowns, then still cascade
      if (l1Cls.isBilling) markKey24hCooldown(slot, 'L1 billing disabled');
      else if (l1Cls.is429) markKeyCooldown(slot);

      console.warn(`[v3.3-NANO-BANANA-ADMIN] L1 ${L1_PRIMARY_MODEL} failed (${l1Msg.slice(0, 120)}) → L2 ${L2_STABILITY_MODEL}`);

      // ─── L2: STABILITY (Gemini 2.5 Flash Image — VERIFIED WORKING) ─────
      try {
        const result = await this._callModel(slot, L2_STABILITY_MODEL, contents, mode, VERTEX_LOCATION, apiVersion);
        console.log(`[v3.3-NANO-BANANA-ADMIN] L2 SUCCESS | model=${L2_STABILITY_MODEL}`);
        return result;
      } catch (l2Err: any) {
        const l2Msg = l2Err?.message || "";
        const l2Cls = classifyError(l2Err, l2Msg, l2Err?.details || [], [l2Msg, stringifyErrorDetails(l2Err)].join(" "));
        if (l2Cls.isBilling) markKey24hCooldown(slot, 'L2 billing disabled');
        else if (l2Cls.is429) markKeyCooldown(slot);

        console.warn(`[v3.3-NANO-BANANA-ADMIN] L2 ${L2_STABILITY_MODEL} failed (${l2Msg.slice(0, 120)}) → L3 ${L3_SAFETY_NET_MODEL}`);

        // ─── L3: SAFETY NET (Imagen 3.0 via :predict endpoint) ──────────
        try {
          const result = await this._callImagenPredict(L3_SAFETY_NET_MODEL, prompt, additionalImages);
          console.log(`[v3.3-NANO-BANANA-ADMIN] L3 SUCCESS | model=${L3_SAFETY_NET_MODEL} (:predict)`);
          return result;
        } catch (l3Err: any) {
          const l3Msg = l3Err?.message || "";
          console.error(`[v3.3-NANO-BANANA-ADMIN] L3 ${L3_SAFETY_NET_MODEL} failed (${l3Msg.slice(0, 200)})`);
          console.error(`[v3.3-NANO-BANANA-ADMIN] FATAL: Full fallback chain exhausted (L1 → L2 → L3). Last err: ${l3Msg.slice(0, 200)}`);
          throw new Error(`[v3.3] All image generation models failed. L1=${l1Msg.slice(0,80)} | L2=${l2Msg.slice(0,80)} | L3=${l3Msg.slice(0,80)}`);
        }
      }
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
