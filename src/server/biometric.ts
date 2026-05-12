// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V7.0 — Biometric Profile & Preflight Audit (S-Tier Likeness)
// ═════════════════════════════════════════════════════════════════════════════
//
// Purpose:
//   Imagen 3 Subject Customization uses `subjectDescription` as the SEMANTIC
//   ANCHOR that conditions cross-attention onto the reference face. A generic
//   description ("primary subject portrait") yields generic faces and lets
//   the model drift toward training-set means (= CGI/cartoon hallucinations).
//
//   This module produces a rich, structured biometric profile of the user
//   from their reference photos — extracted in ONE Gemini 2.5 Flash call —
//   and renders it into the precise prose Imagen needs to lock identity.
//
// Pipeline:
//   refs[] ──► auditReferences() ──► PreflightAudit
//                                        │
//                                        ├── perImage[] (gate bad uploads)
//                                        └── fingerprint (raw biometrics)
//                                                ▼
//                          mergeProfile(fingerprint, userGender, userAge)
//                                                ▼
//                                        SubjectProfile
//                                                ▼
//                          buildSubjectDescription(profile, view) ──► Imagen
//                          buildIdentityHeader(profile)         ──► prompts
//
// The audit ALSO catches bad inputs (sunglasses, blur, multi-people, no face)
// BEFORE credit consumption — wasting 0% of Imagen budget on garbage refs.
// ═════════════════════════════════════════════════════════════════════════════

import type { AgeTier, Gender } from "./prompts.js";

// ─── Public types ───────────────────────────────────────────────────────────

export type SkinTone =
  | "fair" | "light" | "medium" | "olive" | "tan" | "brown" | "deep";

export type HairColor =
  | "black" | "dark-brown" | "brown" | "auburn" | "blonde" | "red"
  | "grey" | "white" | "bald" | "other";

export type HairLength = "very-short" | "short" | "medium" | "long" | "bald";

export type EyeColor =
  | "brown" | "hazel" | "green" | "blue" | "grey" | "amber" | "dark";

export type FacialHair =
  | "none" | "stubble" | "short-beard" | "full-beard" | "moustache";

export interface BiometricFingerprint {
  apparentAge: AgeTier;
  perceivedGender: "male" | "female" | "ambiguous";
  skinTone: SkinTone;
  hairColor: HairColor;
  hairLength: HairLength;
  eyeColor: EyeColor;
  facialHair: FacialHair;
  distinguishingFeatures: string[];   // ≤5 short tags, e.g. "freckles", "strong jawline"
  sameIdentityAcrossPhotos: boolean;
}

export type ImageRejectReason =
  | "sunglasses"
  | "mask"
  | "obstructed_face"
  | "blurry"
  | "low_resolution"
  | "multiple_people"
  | "no_face"
  | "back_view"
  | "extreme_angle"
  | "heavy_filter"
  | "tiny_face"
  | "harsh_shadow"
  | "duplicate";

export interface PerImageVerdict {
  ok: boolean;
  usable: boolean;
  issues: ImageRejectReason[];
}

export interface PreflightAudit {
  perImage: PerImageVerdict[];
  fingerprint: BiometricFingerprint;
  fatalIssues: string[];
}

/** Merged profile: audit fingerprint reconciled with user-supplied UI signals. */
export interface SubjectProfile {
  ageTier: AgeTier;
  gender: Gender;
  skinTone: SkinTone;
  hairColor: HairColor;
  hairLength: HairLength;
  eyeColor: EyeColor;
  facialHair: FacialHair;
  distinguishingFeatures: string[];
  /** Source of truth for diagnostics: "user", "audit", or "merged". */
  source: "user" | "audit" | "merged";
}

// ─── Configuration ──────────────────────────────────────────────────────────

/** Premium needs at least this many usable refs; below this we reject. */
export const MIN_USABLE_REFS_PREMIUM = 5;
/** Free-tier can squeeze through with a single passable ref. */
export const MIN_USABLE_REFS_FREE = 1;

/** Hard reject: these issues are non-recoverable. */
const FATAL_PER_IMAGE_ISSUES = new Set<ImageRejectReason>([
  "sunglasses",
  "mask",
  "obstructed_face",
  "no_face",
  "back_view",
  "multiple_people",
]);

// ─── Audit prompt (single batched call) ─────────────────────────────────────

/**
 * The judge gets all reference images in one multimodal call and must return
 * pure JSON conforming to PreflightAudit.  We keep the schema flat so Gemini
 * Flash returns deterministic results even without responseSchema enforcement.
 */
export const AUDIT_PROMPT = `You are a strict biometric audit system for an AI portrait service.
You will receive multiple reference photos that should depict the SAME person.

Step 1 — for EACH photo (in the order given), produce a verdict:
{
  "ok":     boolean,           // false if any issue prevents identity preservation
  "issues": [string, ...],     // any of: "sunglasses", "mask", "obstructed_face",
                               // "blurry", "low_resolution", "multiple_people",
                               // "no_face", "back_view", "extreme_angle",
                               // "heavy_filter", "tiny_face", "harsh_shadow",
                               // "duplicate"
  "usable": boolean            // true ONLY if face is fully visible, sharp,
                               // identifiable, and the SAME person as others
}

Step 2 — produce ONE aggregate fingerprint of the dominant person across
the usable photos:
{
  "apparentAge":           "young" | "mature" | "distinguished",
  "perceivedGender":       "male" | "female" | "ambiguous",
  "skinTone":              "fair" | "light" | "medium" | "olive" | "tan" | "brown" | "deep",
  "hairColor":             "black" | "dark-brown" | "brown" | "auburn" | "blonde" | "red" | "grey" | "white" | "bald" | "other",
  "hairLength":            "very-short" | "short" | "medium" | "long" | "bald",
  "eyeColor":              "brown" | "hazel" | "green" | "blue" | "grey" | "amber" | "dark",
  "facialHair":            "none" | "stubble" | "short-beard" | "full-beard" | "moustache",
  "distinguishingFeatures": [up to 5 short tags such as "freckles", "strong jawline", "dimples", "high cheekbones", "sharp brow", "full lips"],
  "sameIdentityAcrossPhotos": boolean
}

Step 3 — populate "fatalIssues" ONLY IF the request is unusable as a whole
(e.g. ["no_usable_photos"], ["different_people_detected"]).

Output ONE JSON object with this exact shape:
{
  "perImage":     [...],
  "fingerprint":  {...},
  "fatalIssues":  [string, ...]
}

Output JSON ONLY — no prose, no code fences.
Apparent age guidance:
  - "young":          under 30
  - "mature":         30–50
  - "distinguished":  50+`;

// ─── Parsing ────────────────────────────────────────────────────────────────

const VALID_AGES = new Set(["young", "mature", "distinguished"]);
const VALID_GENDERS = new Set(["male", "female", "ambiguous"]);
const VALID_SKIN = new Set(["fair", "light", "medium", "olive", "tan", "brown", "deep"]);
const VALID_HAIR_COLOR = new Set(["black", "dark-brown", "brown", "auburn", "blonde", "red", "grey", "white", "bald", "other"]);
const VALID_HAIR_LENGTH = new Set(["very-short", "short", "medium", "long", "bald"]);
const VALID_EYE = new Set(["brown", "hazel", "green", "blue", "grey", "amber", "dark"]);
const VALID_FACIAL_HAIR = new Set(["none", "stubble", "short-beard", "full-beard", "moustache"]);

/** Defensive: if the judge returns an unexpected shape, fall back to safe defaults. */
function clean<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback;
}

export function parseAuditResponse(raw: string, expectedCount: number): PreflightAudit {
  // Tolerate ```json ... ``` fencing if the model adds it despite instructions.
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch (err: any) {
    throw new Error(`[audit] failed to parse judge JSON: ${err.message} | raw=${stripped.slice(0, 200)}`);
  }

  const perImageRaw: any[] = Array.isArray(parsed?.perImage) ? parsed.perImage : [];
  const perImage: PerImageVerdict[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const v = perImageRaw[i] || {};
    perImage.push({
      ok: v.ok === true,
      usable: v.usable === true,
      issues: Array.isArray(v.issues)
        ? v.issues.filter((x: any): x is ImageRejectReason => typeof x === "string").slice(0, 8)
        : [],
    });
  }

  const fpRaw = parsed?.fingerprint || {};
  const fingerprint: BiometricFingerprint = {
    apparentAge: clean<AgeTier>(fpRaw.apparentAge, VALID_AGES, "mature"),
    perceivedGender: clean<"male" | "female" | "ambiguous">(fpRaw.perceivedGender, VALID_GENDERS, "ambiguous"),
    skinTone: clean<SkinTone>(fpRaw.skinTone, VALID_SKIN, "medium"),
    hairColor: clean<HairColor>(fpRaw.hairColor, VALID_HAIR_COLOR, "dark-brown"),
    hairLength: clean<HairLength>(fpRaw.hairLength, VALID_HAIR_LENGTH, "short"),
    eyeColor: clean<EyeColor>(fpRaw.eyeColor, VALID_EYE, "dark"),
    facialHair: clean<FacialHair>(fpRaw.facialHair, VALID_FACIAL_HAIR, "none"),
    distinguishingFeatures: Array.isArray(fpRaw.distinguishingFeatures)
      ? fpRaw.distinguishingFeatures
          .filter((s: any) => typeof s === "string" && s.length > 0 && s.length < 60)
          .filter(s => !/acne|pimple|blemish|spot|scar|wrinkle|pore|texture|mark/i.test(s))
          .slice(0, 5)
      : [],
    sameIdentityAcrossPhotos: fpRaw.sameIdentityAcrossPhotos !== false,
  };

  const fatalIssues: string[] = Array.isArray(parsed?.fatalIssues)
    ? parsed.fatalIssues.filter((s: any) => typeof s === "string").slice(0, 5)
    : [];

  return { perImage, fingerprint, fatalIssues };
}

// ─── Audit gate ─────────────────────────────────────────────────────────────

export interface AuditGateResult {
  pass: boolean;
  reason?: string;
  usableCount: number;
  totalCount: number;
  rejectedReasons: ImageRejectReason[];
}

/**
 * Decides whether an audited request may proceed. Public gate logic — pure
 * function so it is easily unit-testable.
 */
export function evaluateAuditGate(
  audit: PreflightAudit,
  tier: "free" | "premium",
  isAdmin: boolean = false
): AuditGateResult {
  const totalCount = audit.perImage.length;
  const usable = audit.perImage.filter(p => p.usable);
  const usableCount = usable.length;

  // ── V2.0 Admin Bypass ──
  // Automatically passes audit for admin accounts regardless of quality.
  if (isAdmin) {
    console.warn(`[Audit] 🚨 ADMIN BYPASS ACTIVATED. usable=${usableCount}/${totalCount}`);
    return { pass: true, usableCount: totalCount, totalCount, rejectedReasons: [] };
  }

  if (audit.fatalIssues.includes("different_people_detected") || !audit.fingerprint.sameIdentityAcrossPhotos) {
    return {
      pass: false,
      reason: "Reference photos appear to depict more than one person. Please upload photos of yourself only.",
      usableCount,
      totalCount,
      rejectedReasons: ["multiple_people"],
    };
  }

  const min = tier === "premium" ? MIN_USABLE_REFS_PREMIUM : MIN_USABLE_REFS_FREE;
  if (usableCount < min) {
    // Aggregate the most common reasons so the UI can show actionable guidance.
    const counts = new Map<ImageRejectReason, number>();
    for (const p of audit.perImage) {
      for (const r of p.issues) {
        counts.set(r, (counts.get(r) || 0) + 1);
      }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
    const fatalSeen = ranked.filter(r => FATAL_PER_IMAGE_ISSUES.has(r)).slice(0, 3);
    const human = humanizeRejection(fatalSeen, usableCount, min);
    return {
      pass: false,
      reason: human,
      usableCount,
      totalCount,
      rejectedReasons: fatalSeen,
    };
  }

  return { pass: true, usableCount, totalCount, rejectedReasons: [] };
}

function humanizeRejection(reasons: ImageRejectReason[], usable: number, min: number): string {
  const labels: Record<ImageRejectReason, string> = {
    sunglasses: "тёмные очки",
    mask: "маски на лице",
    obstructed_face: "перекрытое лицо",
    blurry: "размытые фото",
    low_resolution: "слишком низкое разрешение",
    multiple_people: "несколько людей в кадре",
    no_face: "лица не видно",
    back_view: "вид сзади / в профиль без лица",
    extreme_angle: "экстремальный ракурс",
    heavy_filter: "сильные фильтры/ретушь",
    tiny_face: "лицо слишком мелкое в кадре",
    harsh_shadow: "слишком жёсткие тени на лице",
    duplicate: "дубликаты",
  };
  const labeled = reasons.map(r => labels[r] || r).join(", ");
  const head = `Только ${usable} из загруженных фото подходят для генерации (нужно минимум ${min}).`;
  return labeled ? `${head} Замечено: ${labeled}.` : head;
}

// ─── Profile merging (audit ⨉ user UI signals) ──────────────────────────────

/**
 * Reconcile the audit fingerprint with what the user told us in the UI.
 * User-supplied signals are TRUSTED when set (gender !== "unset"); the audit
 * fills the gaps and provides everything Imagen needs (skin/hair/eyes/etc).
 *
 * If the user said one thing and the audit strongly disagrees, we still favour
 * the user — they know themselves better than a 5-second vision call. The only
 * exception is when the user left ageTier on the default and the audit returns
 * a confident reading, in which case we accept it.
 */
export function mergeProfile(
  audit: PreflightAudit,
  userGender: Gender,
  userAgeTier: AgeTier,
): SubjectProfile {
  const fp = audit.fingerprint;

  const gender: Gender =
    userGender !== "unset"
      ? userGender
      : fp.perceivedGender === "ambiguous"
        ? "unset"
        : fp.perceivedGender;

  // The UI ageTier defaults to "young" — we cannot disambiguate "user picked
  // young" from "user left default" without an explicit "unset" sentinel,
  // so we always prefer the user input here. Cheap, predictable, no surprises.
  const ageTier: AgeTier = userAgeTier;

  return {
    ageTier,
    gender,
    skinTone: fp.skinTone,
    hairColor: fp.hairColor,
    hairLength: fp.hairLength,
    eyeColor: fp.eyeColor,
    facialHair: fp.facialHair,
    distinguishingFeatures: fp.distinguishingFeatures,
    source: userGender !== "unset" ? "merged" : "audit",
  };
}

// ─── Prose builders ─────────────────────────────────────────────────────────

const AGE_DESCRIPTOR: Record<AgeTier, string> = {
  young: "in their early twenties",
  mature: "in their early thirties",
  distinguished: "in their late forties to fifties",
};

const GENDER_DESCRIPTOR: Record<Gender, string> = {
  male: "man",
  female: "woman",
  unset: "person",
};

function safe(s: string): string {
  return s.replace(/[^\w\s\-]/g, "").trim();
}

/**
 * Imagen 3 Subject Customization `subjectDescription` (V8.0).
 *
 * In Imagen 3 the prompt is templated with `[1]` markers and the
 * `subjectDescription` is the SHORT noun phrase that replaces those markers
 * when the cross-attention layer locks identity onto the reference face.
 * Per Google's docs the description should be a generic 2-4 word noun phrase
 * — concrete enough to anchor (gender + age tier), abstract enough not to
 * fight the visual reference (no hair/skin/eyes prose).
 *
 *   "the man"          ← unset gender + young
 *   "the mature man"   ← male + mature
 *   "the distinguished woman" ← female + distinguished
 *
 * The `_isPrimary` and `_viewIndex` parameters are kept for API
 * compatibility but no longer affect output: every reference of the same
 * person uses the same `referenceId: 1` and the same description.
 */
export function buildSubjectDescription(
  profile: SubjectProfile,
  _isPrimary: boolean,
  _viewIndex: number,
): string {
  const noun = GENDER_DESCRIPTOR[profile.gender]; // "man" | "woman" | "person"
  // V9.0: Neutral subject anchor. Age/style adjectives in the [1] marker
  // cause identity drift toward model averages. The visual reference
  // carries the age; the prose should only provide the grammatic noun.
  return `the ${noun}`;
}

/**
 * Detailed identity header injected at the front of every generation prompt
 * (V8.3 biometric-enhanced anchor).
 */
export function buildIdentityHeader(profile: SubjectProfile): string {
  const parts = [
    "A specific individual.",
    profile.gender !== "unset" ? GENDER_DESCRIPTOR[profile.gender] : "person",
    profile.skinTone ? `${profile.skinTone} skin tone` : "",
    profile.hairColor ? `${profile.hairColor} hair` : "",
    profile.facialHair !== "none" ? profile.facialHair : "",
    ...(profile.distinguishingFeatures || []),
  ].filter(Boolean);

  return `${parts.join(", ")}. The exact person shown in the reference images.`;
}

/** A safe fallback profile for edge-cases where audit fails but we still want
 *  to attempt generation. Uses only user-supplied signals; biometric anchors
 *  fall back to neutral values that don't bias the model toward any phenotype. */
export function profileFromUserOnly(gender: Gender, ageTier: AgeTier): SubjectProfile {
  return {
    ageTier,
    gender,
    skinTone: "medium",
    hairColor: "dark-brown",
    hairLength: "short",
    eyeColor: "dark",
    facialHair: "none",
    distinguishingFeatures: [],
    source: "user",
  };
}
