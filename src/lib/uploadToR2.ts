/**
 * Direct-to-R2 upload pipeline (Phase 2).
 *
 * Why this exists:
 *   Cloud Run caps HTTP request bodies at 32 MB. Premium users upload 10-15
 *   high-res photos (easily 50-100 MB total). Instead of streaming those
 *   bytes through our Node server, we mint presigned PUT URLs on the backend
 *   and the browser PUTs files directly to Cloudflare R2. The server then
 *   receives only the resulting object keys in POST /api/generate.
 *
 * Flow:
 *   1. requestUploadUrls({files, packageId})  →  POST /api/upload-urls
 *      Server validates size/MIME/count and returns one presigned URL per file.
 *   2. uploadFilesToR2(files, slots, onProgress)
 *      Browser PUTs each file directly to R2 in parallel (bounded concurrency).
 *      Returns the final R2 keys, which then go into POST /api/generate.
 *
 * All backend calls go through apiFetch so the Telegram initData signature
 * is attached. R2 PUTs do NOT use apiFetch — they go straight to R2 with the
 * presigned URL (which is self-authenticating).
 */

import { apiFetch } from "./api";

// ─── Types mirror src/server/storage.ts (PresignedUploadSlot) ──────────────
export interface UploadSlot {
  key: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export interface PresignResponse {
  uploads: UploadSlot[];
  ttlSec: number;
}

export interface UploadProgress {
  /** 0-based index in the original files[] array */
  index: number;
  /** Filename (for UI display) */
  name: string;
  /** completed / total bytes for THIS file */
  loaded: number;
  total: number;
  /** High-level state machine */
  state: "pending" | "uploading" | "done" | "error";
  error?: string;
}

// Map any File.type (including iOS "image/heif-sequence" edge cases) into a
// MIME the backend accepts. We keep this conservative — if the browser does
// not give us a recognised type, we throw early so the user sees a clear error.
function normaliseContentType(file: File): string {
  const t = (file.type || "").toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(t)) {
    return t;
  }
  // iOS sometimes reports "image/heif-sequence" or "image/heic-sequence"
  if (t.startsWith("image/heif")) return "image/heif";
  if (t.startsWith("image/heic")) return "image/heic";
  if (t === "image/jpg") return "image/jpeg";
  throw new Error(`Unsupported file type "${file.type || "unknown"}" on "${file.name}"`);
}

// ─── Step 7a: mint presigned URLs ─────────────────────────────────────────
export async function requestUploadUrls(params: {
  files: File[];
  packageId: "free" | "starter" | "pro" | "max";
}): Promise<UploadSlot[]> {
  const { files, packageId } = params;
  if (files.length === 0) throw new Error("No files provided");

  const payload = {
    packageId,
    files: files.map(f => ({
      name: f.name.slice(0, 200),
      size: f.size,
      contentType: normaliseContentType(f),
    })),
  };

  const res = await apiFetch("/api/upload-urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    const msg = body?.error || `HTTP ${res.status}`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.code = body?.code;
    err.details = body?.details;
    throw err;
  }
  const slots: UploadSlot[] = body?.uploads || [];
  if (slots.length !== files.length) {
    throw new Error(`Server returned ${slots.length} slots for ${files.length} files`);
  }
  return slots;
}

// ─── Step 7b: PUT files to R2 with bounded concurrency ────────────────────
/**
 * Upload one file to R2 via its presigned slot, reporting per-file byte progress.
 *
 * We use XMLHttpRequest (not fetch) because only XHR exposes an `upload.onprogress`
 * event for request bodies. That is what drives the UI progress bars.
 */
function putOneFileXhr(
  file: File,
  slot: UploadSlot,
  onByteProgress: (loaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", slot.url, true);
    for (const [k, v] of Object.entries(slot.headers)) {
      // Content-Length is forbidden to set manually in some browsers — XHR
      // computes it automatically from the body, and R2's signed value must
      // match what the browser sends, which it does for a File blob.
      if (k.toLowerCase() === "content-length") continue;
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onByteProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onByteProgress(file.size, file.size); // ensure UI shows 100%
        resolve();
      } else {
        reject(new Error(`R2 PUT failed: HTTP ${xhr.status} — ${xhr.responseText?.slice(0, 300) || xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("R2 PUT network error"));
    xhr.onabort = () => reject(new Error("R2 PUT aborted"));
    xhr.send(file);
  });
}

async function putWithRetry(
  file: File,
  slot: UploadSlot,
  onByteProgress: (loaded: number, total: number) => void,
  maxAttempts: number = 3
): Promise<void> {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await putOneFileXhr(file, slot, onByteProgress);
      return;
    } catch (err: any) {
      lastErr = err;
      // 4xx are almost always permanent (wrong content-type, expired signature)
      // — only retry on network-flavoured failures.
      const msg = String(err?.message || "");
      const isRetryable = msg.includes("network") || msg.includes("aborted") || msg.includes("5");
      if (!isRetryable || attempt === maxAttempts) break;
      // Linear backoff: 400ms, 800ms
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Upload all files to their presigned slots with bounded concurrency.
 *
 * Returns the R2 object keys in the same order as the input files, so the
 * caller can send them to /api/generate without any reordering bugs.
 */
export async function uploadFilesToR2(
  files: File[],
  slots: UploadSlot[],
  onProgress?: (progress: UploadProgress[]) => void,
  concurrency: number = 3
): Promise<string[]> {
  if (files.length !== slots.length) {
    throw new Error(`files.length (${files.length}) !== slots.length (${slots.length})`);
  }

  const progress: UploadProgress[] = files.map((f, i) => ({
    index: i,
    name: f.name,
    loaded: 0,
    total: f.size,
    state: "pending",
  }));
  const emit = () => onProgress?.(progress.map(p => ({ ...p })));
  emit();

  // Bounded-concurrency worker pool
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      const file = files[i];
      const slot = slots[i];
      progress[i].state = "uploading";
      emit();
      try {
        await putWithRetry(file, slot, (loaded, total) => {
          progress[i].loaded = loaded;
          progress[i].total = total;
          emit();
        });
        progress[i].state = "done";
      } catch (err: any) {
        progress[i].state = "error";
        progress[i].error = err?.message || String(err);
        emit();
        throw err; // abort the whole batch on first hard failure
      }
      emit();
    }
  };

  // Launch up to `concurrency` workers, but never more than files.length
  const n = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: n }, worker));

  return slots.map(s => s.key);
}
