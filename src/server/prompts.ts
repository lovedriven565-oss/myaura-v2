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

// ─── V9 "Value Gap" Architecture ─────────────────────────────────────────────
//
// Design philosophy:
//   FREE tier  → Flawless, clean, editorial-grade. Feels polished and complete
//                on its own. Uses gentle aesthetic keywords that the smaller
//                model (gemini-2.5-flash-image) can execute reliably without
//                drifting into plastic/uncanny territory.
//
//   PREMIUM    → Full optical-physics payload. Forces the heavier model
//                (gemini-3-pro-image-preview) to leverage its additional
//                reasoning capacity on lens geometry, micro-skin texture,
//                catchlight symmetry, and anatomical coherence.
//
// Both tiers share the same identity anchor, framing rotation, and demographic
// injection — the ONLY thing that changes is the aesthetic suffix and the
// negative-prompt strictness. This keeps the value gap visible but non-broken:
// a Free user still gets a usable portrait, a Premium user gets a Vogue cover.

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

const STYLE_BLOCKS: Record<StyleId, StyleBlock> = {
  business: {
    subject: "dressed in a sharply tailored dark suit with a crisp shirt, composed professional posture",
    environment: "modern glass-walled corporate office with soft diffused north-window light, subtle architectural bokeh",
    mood: "confident, authoritative, quietly powerful",
  },
  lifestyle: {
    subject: "wearing neutral-tone cashmere knitwear or softly tailored casuals, natural relaxed posture",
    environment: "warm golden-hour outdoor setting with gentle lens flare and creamy background blur",
    mood: "approachable, candid, effortlessly elegant",
  },
  cinematic: {
    subject: "wearing dark structured clothing, contemplative gaze slightly off-camera",
    environment: "low-key studio with practical tungsten backlights and atmospheric haze",
    mood: "moody, intense, film-noir restraint with teal-and-orange grading",
  },
  editorial: {
    subject: "wearing a bold avant-garde silhouette, striking editorial pose",
    environment: "seamless minimal paper-backdrop studio, overhead beauty dish with fill reflector",
    mood: "high-contrast, magazine-cover confidence, gallery-grade composition",
  },
  luxury: {
    subject: "wearing bespoke silk or fine merino layering with subtle gold accents",
    environment: "grand private library or hotel suite with warm ambient reading lamps, antique texture",
    mood: "quiet wealth, understated sophistication, heritage elegance",
  },
  aura: {
    subject: "wearing flowing translucent fabric that catches the light",
    environment: "abstract backdrop with soft volumetric light rays and iridescent color shifts",
    mood: "ethereal, dreamlike, fine-art dream-pop",
  },
  // ── Premium-exclusive styles ──────────────────────────────────────────
  cyberpunk: {
    subject: "wearing a sleek techwear jacket with subtle neon piping, sharp silhouette",
    environment: "neon-drenched night cityscape with rain reflections, atmospheric haze, purple-and-cyan signage bokeh",
    mood: "futuristic, kinetic, blade-runner atmosphere",
  },
  corporate: {
    subject: "in an impeccable charcoal suit with conservative tie, hands composed, boardroom posture",
    environment: "Fortune-500 executive suite, floor-to-ceiling window skyline, brushed-metal desk details",
    mood: "CEO-tier authority, institutional trust, LinkedIn-executive polish",
  },
  ethereal: {
    subject: "wearing diaphanous pale fabric, serene expression, gentle chiaroscuro on the face",
    environment: "soft misted studio with morning god-rays cutting through dust particles, pastel gradient backdrop",
    mood: "celestial, painterly, Renaissance fresco sensibility",
  },
};

const VARIETY_FRAMINGS = [
  "Perfectly centered frontal portrait",
  "Subtle 3/4 angle portrait",
  "Medium close-up portrait",
  "Head-and-shoulders portrait",
  "Environmental portrait with background depth",
  "Relaxed posture three-quarter portrait",
];

// ── Tier-differentiated aesthetic suffixes ───────────────────────────────────
// FREE_SUFFIX is the polished floor — clean, editorial, safe for any model.
// PREMIUM_SUFFIX is the optical-physics payload — sensor, lens, grade, grain,
// catchlights, anatomical anchors. This is what the heavier model rewards.
const FREE_AESTHETIC_SUFFIX =
  "Editorial-grade color balance, soft diffused light, natural skin tone, gentle background separation, tasteful composition, clean and polished finish.";

const PREMIUM_AESTHETIC_SUFFIX = [
  // Optical physics
  "Shot on Sony A7 IV full-frame sensor, Sony GM 85mm f/1.4 prime lens, shallow depth of field with creamy bokeh roll-off",
  // Cinematic grade
  "S-Cinetone color science, subtle teal-shadow / warm-highlight grading, 35mm organic film grain",
  // Skin realism
  "hyper-realistic skin micro-texture with visible pores and natural subsurface scattering, no plastic smoothing",
  // Eye / anatomy anchors
  "symmetric catchlights, anatomically correct hand articulation, anatomical knuckle definition, preserved iris pattern detail",
  // Editorial polish
  "Vogue-tier composition, commercial-grade retouch, gallery-print sharpness",
].join(". ") + ".";

// ── Negative prompts: tier-aware strictness ──────────────────────────────────
const BASE_NEGATIVE =
  "different person, altered facial features, changed eye color, distorted anatomy, extra fingers, malformed hands, text artifacts, watermarks";

const PREMIUM_NEGATIVE_ANCHORS =
  ", plastic skin, wax-like complexion, airbrushed artifacts, uncanny AI-look, over-retouched porcelain, CGI sheen, 3D render tells, smeared irises, rubber-band jawline, cartoon proportions";

// ── Identity core (shared) ───────────────────────────────────────────────────
const IDENTITY_CORE =
  "A photorealistic portrait of the same person shown in the reference photos. " +
  "CRITICAL: Maintain strict physical likeness to the references. Preserve the exact " +
  "facial structure, eye shape, natural eye color, nose, jawline, skin tone, and overall " +
  "recognizability. Do not alter, beautify, idealize, or reinterpret the subject's identity.";

function describeDemographics(gender: Gender, ageTier: AgeTier): string {
  const ageHint =
    ageTier === "young"
      ? "the subject appears 20–30 years old, fresh youthful skin"
      : ageTier === "mature"
      ? "the subject appears 30–45 years old, refined adult features with natural skin character"
      : "the subject appears 45+ years old, distinguished features with natural aging traits — subtle fine lines, mature skin texture preserved";

  const genderHint =
    gender === "male"
      ? "masculine presentation consistent with the references"
      : gender === "female"
      ? "feminine presentation consistent with the references"
      : "gender presentation faithfully mirrored from the references";

  return `Demographics: ${ageHint}; ${genderHint}.`;
}

function buildV9Prompt(
  gender: Gender,
  styleId: StyleId,
  ageTier: AgeTier,
  mode: PromptType,
  index: number,
): string {
  const styleBlock = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const demographics = describeDemographics(gender, ageTier);

  // Composition layer — shared across tiers
  const composition =
    `${IDENTITY_CORE} ${demographics} Framing: ${framing}. ` +
    `Subject: ${styleBlock.subject}. ` +
    `Environment: ${styleBlock.environment}. ` +
    `Mood: ${styleBlock.mood}. `;

  // Aesthetic layer — differentiates Free vs Premium
  const aesthetic = mode === "premium" ? PREMIUM_AESTHETIC_SUFFIX : FREE_AESTHETIC_SUFFIX;

  return composition + aesthetic;
}

function buildNegativePrompt(mode: PromptType): string {
  return mode === "premium" ? BASE_NEGATIVE + PREMIUM_NEGATIVE_ANCHORS : BASE_NEGATIVE;
}

export function buildPromptProfile(
  styleId: StyleId,
  mode: PromptType,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset",
): { positivePrompt: string; negativePrompt: string; debugPromptParts: DebugPromptParts } {
  const positivePrompt = buildV9Prompt(gender, styleId, ageTier, mode, index);
  const negativePrompt = buildNegativePrompt(mode);

  const debugPromptParts: DebugPromptParts = {
    version: "V9-ValueGap",
    styleId,
    mode,
    gender,
    ageTier,
    index,
  };

  console.log(
    `[PROMPT V9-ValueGap] style=${styleId} mode=${mode} gender=${gender} age=${ageTier} idx=${index}`,
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
 * Returns the set of styles allowed for a given tier.
 * Use this in the UI/validation to gate premium-exclusive styles.
 */
export function getAvailableStyles(mode: PromptType): readonly StyleId[] {
  return mode === "premium" ? [...CORE_STYLES, ...PREMIUM_EXCLUSIVE_STYLES] : CORE_STYLES;
}

export function isPremiumOnlyStyle(styleId: StyleId): boolean {
  return PREMIUM_EXCLUSIVE_STYLES.includes(styleId);
}
