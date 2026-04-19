/**
 * Single source of truth for direct-to-R2 upload limits.
 *
 * Values deliberately conservative:
 *   - 20 MB per file covers original HEIC from recent iPhones (typically 2-6 MB)
 *     with headroom for DSLR JPEGs, but rejects clearly-abusive uploads.
 *   - 15 files matches the Max package's upper bound (see packages.ts).
 *   - 10-minute TTL is long enough for slow 3G while small enough that a leaked
 *     URL becomes useless quickly.
 *
 * All values are env-overridable for emergency tuning without a redeploy.
 */

export const MAX_FILE_SIZE_BYTES = parseInt(
  process.env.UPLOAD_MAX_FILE_SIZE_BYTES || String(20 * 1024 * 1024)
);

export const MAX_FILES_PER_REQUEST = parseInt(
  process.env.UPLOAD_MAX_FILES_PER_REQUEST || "15"
);

export const PRESIGN_TTL_SEC = parseInt(
  process.env.UPLOAD_PRESIGN_TTL_SEC || "600" // 10 minutes
);

export const UPLOAD_KEY_PREFIX = "uploads/";

export const ALLOWED_UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type AllowedUploadContentType = typeof ALLOWED_UPLOAD_CONTENT_TYPES[number];

const EXT_BY_MIME: Record<AllowedUploadContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/**
 * Map a validated MIME to a file extension for the R2 key.
 * Using a server-chosen extension (rather than echoing the client's filename)
 * closes off path-injection and double-extension ("file.jpg.exe") tricks.
 */
export function extensionForContentType(mime: AllowedUploadContentType): string {
  return EXT_BY_MIME[mime];
}

/**
 * Build the canonical R2 key for an uploaded reference photo.
 *
 * Format: uploads/{telegramUserId}/{uuid}.{ext}
 *
 * Rationale:
 *   - Prefixed with the user's telegram_id so our /generate handler can
 *     authorize "this key belongs to this caller" with a simple prefix check.
 *   - UUID prevents collisions and unguessable enumeration.
 *   - Extension chosen by us (never from client), so malicious ".exe" suffixes
 *     cannot reach R2.
 */
export function buildUploadKey(
  telegramUserId: number,
  uuid: string,
  contentType: AllowedUploadContentType
): string {
  return `${UPLOAD_KEY_PREFIX}${telegramUserId}/${uuid}.${extensionForContentType(contentType)}`;
}

/**
 * Regex used by GenerateBodySchema (Step 3) to validate that imageKeys sent
 * back to /api/generate conform to our canonical format and belong to the
 * caller. The {userId} capture is checked against req.telegramId at runtime.
 */
export const UPLOAD_KEY_REGEX = /^uploads\/(\d+)\/[a-f0-9-]{36}\.(jpg|png|webp|heic|heif)$/;
