export type PromptType = "free" | "premium";
// Core styles are available to everyone. Premium-exclusive styles are defined
// in PREMIUM_EXCLUSIVE_STYLES and must only be selectable inside the Premium UI.
export type StyleId =
  | "business"
  | "lifestyle"
  | "aura"
  | "cinematic"
  | "luxury"
  | "editorial"
  | "cyberpunk"
  | "corporate"
  | "ethereal";
export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";

export interface DebugPromptParts {
  version: string;
  styleId: StyleId;
  mode: PromptType;
  gender: Gender;
  ageTier: AgeTier;
  index: number;
}

// ─── V13 "Anatomical" Architecture ───────────────────────────────────────────
//
// Design philosophy:
//   1. REFERENCE-FIRST STRUCTURE. Hair Lock and Jawline Lock appear EARLY in the
//      prompt (immediately after medium override) so they receive maximum token
//      weight and override style-driven idealisation.
//
//   2. HAIR LOCK — DEDICATED BLOCK. Explicit, redundant haircut description
//      (shaved sides, buzzed top, receding temples) prevents the model from
//      substituting a generic corporate hairstyle. Redundancy is a fix for bias.
//
//   3. JAWLINE LOCK — DEDICATED BLOCK. "Un-retouched natural jawline, preserve
//      original face width, do not sharpen chin" anchors the subject's unique
//      bone structure and prevents chin elongation / contouring.
//
//   4. STYLE DILUTION. Corporate/Business keywords are reduced to neutral tags
//      ("formal business setting, professional attire") instead of CEO-tier
//      authority language that triggers model bias toward perfect hair and
//      sharpened jawlines.
//
//   5. PUNCHY COMMA-SEPARATED KEYWORDS. No flowing sentences. Each tag is a
//      discrete visual constraint parsed independently.

export const CORE_STYLES: readonly StyleId[] = Object.freeze([
  "business",
  "lifestyle",
  "aura",
  "cinematic",
  "luxury",
  "editorial",
]);

export const PREMIUM_EXCLUSIVE_STYLES: readonly StyleId[] = Object.freeze([
  "cyberpunk",
  "corporate",
  "ethereal",
]);

interface StyleBlock {
  /** Subject — what the person is wearing / doing */
  subject: string;
  /** Environment — background / setting */
  environment: string;
  /** Mood — overall emotional/color tone */
  mood: string;
}

// ── Style tag blocks: punchy comma-separated keywords only ──────────────────
const STYLE_BLOCKS: Record<StyleId, StyleBlock> = {
  business: {
    subject: "sharply tailored dark suit, crisp white shirt, composed professional posture",
    environment: "modern glass-walled corporate office, soft diffused north-window light, subtle architectural bokeh",
    mood: "confident, authoritative, quietly powerful",
  },
  lifestyle: {
    subject: "neutral-tone cashmere knitwear, softly tailored casuals, natural relaxed posture",
    environment: "warm golden-hour outdoor setting, gentle lens flare, creamy background blur",
    mood: "approachable, candid, effortlessly elegant",
  },
  cinematic: {
    subject: "dark structured clothing, contemplative gaze slightly off-camera",
    environment: "low-key studio, practical tungsten backlights, atmospheric haze",
    mood: "moody, intense, film-noir restraint, teal-and-orange grading",
  },
  editorial: {
    subject: "bold avant-garde silhouette, striking editorial pose",
    environment: "seamless minimal paper-backdrop studio, overhead beauty dish, fill reflector",
    mood: "high-contrast, magazine-cover confidence, gallery-grade composition",
  },
  luxury: {
    subject: "bespoke silk, fine merino layering, subtle gold accents",
    environment: "grand private library or hotel suite, warm ambient reading lamps, antique texture",
    mood: "quiet wealth, understated sophistication, heritage elegance",
  },
  aura: {
    subject: "flowing translucent fabric catching the light",
    environment: "abstract backdrop, soft volumetric light rays, iridescent color shifts",
    mood: "ethereal, dreamlike, fine-art dream-pop",
  },
  // ── Premium-exclusive styles ──────────────────────────────────────────
  cyberpunk: {
    subject: "sleek techwear jacket, subtle neon piping, sharp silhouette",
    environment: "neon-drenched night cityscape, rain reflections, atmospheric haze, purple-and-cyan signage bokeh",
    mood: "futuristic, kinetic, blade-runner atmosphere",
  },
  corporate: {
    subject: "formal business setting, professional attire, conservative dark suit, minimal styling, neutral posture",
    environment: "modern office backdrop, neutral lighting, clean background, subtle desk detail",
    mood: "professional, understated, formal",
  },
  ethereal: {
    subject: "diaphanous pale fabric, serene expression, gentle chiaroscuro on the face",
    environment: "soft misted studio, morning god-rays through dust particles, pastel gradient backdrop",
    mood: "celestial, painterly, Renaissance fresco sensibility",
  },
};

const VARIETY_FRAMINGS = [
  "centered frontal portrait",
  "subtle 3/4 angle portrait",
  "medium close-up portrait",
  "head-and-shoulders portrait",
  "environmental portrait with background depth",
  "relaxed posture three-quarter portrait",
];

// ── V13 Medium Override: forces "photo" mode at token 0 ───────────────────
const MEDIUM_OVERRIDE =
  "Authentic candid photograph, raw unretouched skin texture, visible pores, natural facial imperfections, " +
  "direct flash lighting, extremely high detail";

// ── V13 Hair Lock — redundant, explicit haircut description ─────────────────
const HAIR_LOCK =
  "shaved sides, very short buzzed top, natural receding hairline at temples, " +
  "NO added hair volume, exact hair texture from reference, no hairstyle standardization, " +
  "preserve reference haircut geometry, no hairline lowering, no hair density increase";

// ── V13 Jawline Lock — dedicated bone-structure anchor ──────────────────────
const JAWLINE_LOCK =
  "un-retouched natural jawline, preserve original face width, do not sharpen chin, " +
  "no chin elongation, no jawline contouring, original mandible geometry, " +
  "no V-line shaping, no masseter reduction, no chin implant simulation";

// ── V13 Identity Anchors: strict geometry fixation ────────────────────────
function buildAnatomicalLock(ageTier: AgeTier): string {
  const ageLock =
    ageTier === "young"
      ? "young adult age lock"
      : ageTier === "mature"
      ? "mature adult age lock"
      : "distinguished adult age lock";

  return [
    HAIR_LOCK,
    JAWLINE_LOCK,
    "Extreme facial likeness to reference",
    "strict adherence to reference facial bone structure",
    "preserve original cheekbone height",
    ageLock,
  ].join(", ");
}

// ── V13 Demographics: gender + expression + catchlights only ─────────────────
function buildDemographics(gender: Gender, ageTier: AgeTier): string {
  const genderTag =
    gender === "male"
      ? "male"
      : gender === "female"
      ? "female"
      : "gender-neutral";

  const ageTag =
    ageTier === "young"
      ? "mid-twenties age lock, youthful skin texture, adult facial proportions, no baby-face filter, no cheek puffing, no oversized eyes"
      : ageTier === "mature"
      ? "mid-thirties age lock, early expression lines, natural forehead texture, slight crow's feet, no youth filter, no wrinkle erasure"
      : "late-forties age lock, distinguished graying temples, natural forehead lines, crow's feet, nasolabial folds, no age regression, no wrinkle flattening";

  return `${genderTag}, natural expression, realistic Catchlights, ${ageTag}`;
}

// ── V13 Negative Prompt: compressed critical anchors only ──────────────────
const NEGATIVE_PROMPT =
  "different person, smooth skin, beauty filter, altered face geometry, different haircut, " +
  "different hair texture, extra hair volume, plastic face, CGI, 3D render, cartoon, " +
  "digital makeup, teeth whitening, jawline sharpening, chin elongation, asymmetry correction, " +
  "over-optimization, hairline lowering, hair density increase, V-line jaw, masseter reduction";

/**
 * Build a V13 prompt with optional Imagen 3 subject reference token.
 *
 * When subjectRefId is provided (e.g. 1 for Imagen 3 Subject Customization),
 * the token [1] is appended to the gender tag so the model knows which
 * reference image to apply the anatomical description to.
 */
function buildV13Prompt(
  gender: Gender,
  styleId: StyleId,
  ageTier: AgeTier,
  _mode: PromptType,
  index: number,
  subjectRefId?: number,
): string {
  const styleBlock = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const anatomicalLock = buildAnatomicalLock(ageTier);
  let demographics = buildDemographics(gender, ageTier);

  // Inject Imagen 3 subject-reference token (e.g. "male [1], natural expression...")
  // so the model binds the reference image to the described person.
  if (subjectRefId !== undefined && subjectRefId > 0) {
    demographics = demographics.replace(
      /^(male|female|gender-neutral)/,
      `$1 [${subjectRefId}]`
    );
  }

  // V13 Reference-First cascade:
  // Medium Override → Anatomical Lock (Hair + Jawline) → Demographics → Framing → Subject → Environment → Mood
  return [
    MEDIUM_OVERRIDE,
    anatomicalLock,
    demographics,
    framing,
    styleBlock.subject,
    styleBlock.environment,
    styleBlock.mood,
  ].join(", ");
}

function buildNegativePrompt(_mode: PromptType): string {
  return NEGATIVE_PROMPT;
}

export function buildPromptProfile(
  styleId: StyleId,
  mode: PromptType,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset",
  subjectRefId?: number,
): { positivePrompt: string; negativePrompt: string; debugPromptParts: DebugPromptParts } {
  const positivePrompt = buildV13Prompt(gender, styleId, ageTier, mode, index, subjectRefId);
  const negativePrompt = buildNegativePrompt(mode);

  const debugPromptParts: DebugPromptParts = {
    version: subjectRefId ? "V13-Anatomical-Imagen3" : "V13-Anatomical",
    styleId,
    mode,
    gender,
    ageTier,
    index,
  };

  console.log(
    `[PROMPT ${debugPromptParts.version}] style=${styleId} mode=${mode} gender=${gender} age=${ageTier} idx=${index} ref=${subjectRefId ?? "none"}`,
  );
  return { positivePrompt, negativePrompt, debugPromptParts };
}

export function buildPrompt(
  type: PromptType,
  styleId: StyleId,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset",
): { prompt: string; negativePrompt: string } {
  const { positivePrompt, negativePrompt } = buildPromptProfile(styleId, type, index, ageTier, gender);
  return { prompt: positivePrompt, negativePrompt };
}

/**
 * Build a prompt specifically for Imagen 3 Subject Customization.
 * Injects the [1] subject-reference token so the model binds the
 * reference image to the described person.
 */
export function buildPromptForImagen3(
  styleId: StyleId,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset",
): { prompt: string; negativePrompt: string } {
  const { positivePrompt, negativePrompt } = buildPromptProfile(styleId, "premium", index, ageTier, gender, 1);
  return { prompt: positivePrompt, negativePrompt };
}

/**
 * Returns the set of styles allowed for a given tier.
 * Use this in the UI/validation to gate premium-exclusive styles.
 */
export function getAvailableStyles(mode: PromptType): readonly StyleId[] {
  return mode === "premium" ? [...CORE_STYLES, ...PREMIUM_EXCLUSIVE_STYLES] : CORE_STYLES;
}

export function isPremiumOnlyStyle(styleId: StyleId): boolean {
  return PREMIUM_EXCLUSIVE_STYLES.includes(styleId);
}
