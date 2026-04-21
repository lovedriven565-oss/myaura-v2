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

// ─── V10 "Likeness Lock" Architecture ────────────────────────────────────────
//
// Design philosophy:
//   Identity is NON-NEGOTIABLE. Both tiers inherit the same forensic likeness
//   preservation protocol, age-lock anchors, and anti-plasticity clauses.
//
//   FREE tier  → Clean editorial portrait with mandatory realism tokens.
//                The smaller model (gemini-3.1-flash-image-preview) receives
//                enough optical and skin-fidelity anchors to avoid the
//                infamous "AI wax face" without overwhelming its context.
//
//   PREMIUM    → Full optical-physics payload + surgical identity enforcement.
//                gemini-3-pro-image-preview reasons through lens geometry,
//                micro-skin texture, catchlight asymmetry, and anatomical
//                coherence under strict "do not beautify" constraints.
//
// Value gap lives in optical depth, NOT in identity safety. A Free user gets a
// believable human; a Premium user gets a believable human shot on a $4k lens.

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
  "Perfectly centered frontal portrait, raw unedited",
  "Subtle 3/4 angle portrait, raw unedited",
  "Medium close-up portrait, raw unedited",
  "Head-and-shoulders portrait, raw unedited",
  "Environmental portrait with background depth, raw unedited",
  "Relaxed posture three-quarter portrait, raw unedited",
];

// ── Tier-differentiated aesthetic suffixes ───────────────────────────────────
// FREE_SUFFIX is the polished floor — clean, editorial, safe for any model.
// PREMIUM_SUFFIX is the optical-physics payload — sensor, lens, grade, grain,
// catchlights, anatomical anchors. This is what the heavier model rewards.
const FREE_AESTHETIC_SUFFIX =
  "Raw photo, unedited. Shot on 85mm portrait lens, shallow depth of field with natural bokeh. " +
  "Visible skin pores, natural micro-texture, subtle subsurface scattering on ears and nose. " +
  "Accurate daylight color science, no digital smoothing, no beauty filter, no AI gloss. " +
  "Preserve every facial asymmetry, freckle, and natural imperfection exactly as in the reference.";

const PREMIUM_AESTHETIC_SUFFIX = [
  // Optical physics
  "Raw unedited photo. Shot on Sony A7 IV full-frame sensor, Sony GM 85mm f/1.4 prime lens at f/2.0, shallow depth of field with creamy natural bokeh roll-off",
  // Color science
  "Neutral daylight color science, accurate skin tone reproduction without warmth injection, subtle 35mm organic film grain",
  // Skin realism — surgical
  "Hyper-realistic skin micro-texture: visible pores, fine vellus hair, natural sebum sheen on T-zone, subsurface scattering on ears/nose/cheeks, absolutely no plastic smoothing or pore erasure",
  // Eye / anatomy anchors — likeness-critical
  "Asymmetric catchlights matching ambient source, preserved iris pattern detail and limbal ring thickness, correct sclera vascularity, anatomically correct hand articulation and knuckle definition",
  // Anti-beauty mandate
  "NO digital retouching of any kind: no frequency separation, no dodge/burn, no skin smoothing, no teeth whitening, no eye brightening, no jawline sharpening, no cheekbone enhancement, no lip plumping",
  // Editorial frame
  "Vogue-tier composition with commercial-grade RAW fidelity, gallery-print micro-contrast",
].join(". ") + ";";

// ── Negative prompts: tier-aware strictness ──────────────────────────────────
const BASE_NEGATIVE =
  "different person, altered facial features, changed eye color, distorted anatomy, extra fingers, malformed hands, text artifacts, watermarks, symmetry correction, skin smoothing, pore erasure, baby face filter, age regression, age advancement, plastic skin, wax complexion, CGI sheen";

const PREMIUM_NEGATIVE_ANCHORS =
  ", over-retouched porcelain, uncanny AI gloss, digital makeup, beauty filter, teeth whitening, eye enlargement, lip plumping, cheekbone enhancement, jawline sharpening, rubber-band jawline, smeared irises, cartoon proportions, 3D render tells, synthetic hair, blurred pores, porcelain doll effect, Instagram filter, Snapchat filter, frequency separation, dodge and burn";

// ── Identity core (shared) ───────────────────────────────────────────────────
const IDENTITY_CORE =
  "A raw unretouched photorealistic portrait of the EXACT same individual shown in every reference photo. " +
  "IDENTITY PRESERVATION PROTOCOL — MANDATORY: " +
  "(1) Reproduce the identical facial bone structure, eye socket shape, brow ridge contour, nose bridge width and tip geometry, lip fullness and Cupid's bow, jawline angle, chin projection, and ear shape. " +
  "(2) Preserve natural asymmetries: do NOT correct eye size differences, eyebrow height variance, nose deviation, or jaw asymmetry. " +
  "(3) Skin fidelity: reproduce exact pore density, natural sebum sheen, stubble pattern, acne, freckles, moles, scar tissue, under-eye hollows, and nasolabial fold depth. " +
  "(4) Eye fidelity: preserve exact iris color, pattern, and limbal ring thickness; maintain correct sclera vascularity and catchlight geometry. " +
  "(5) Forbidden transforms: NO symmetry correction, NO skin smoothing, NO pore erasure, NO eye enlargement, NO jawline sharpening, NO lip plumping, NO cheekbone enhancement, NO digital makeup, NO teeth whitening, NO wrinkle removal. " +
  "The subject must be immediately recognizable as the same person by a third party who knows them.";

function describeDemographics(gender: Gender, ageTier: AgeTier): string {
  const ageLock =
    ageTier === "young"
      ? "AGE LOCK 24–26: subject must appear exactly mid-twenties. Preserve youthful skin texture but DO NOT infantilize. Retain adult facial proportions, cheekbone height, and jaw width. Forbidden: baby-face filter, cheek puffing, oversized eyes, reduced nose bridge, lip plumping."
      : ageTier === "mature"
      ? "AGE LOCK 35–38: subject must appear exactly mid-thirties. Preserve early expression lines, natural forehead texture, slight crow's feet, and mature skin density. Forbidden: youth filter, wrinkle erasure, skin tightening, glow enhancement, eye bag removal."
      : "AGE LOCK 48–52: subject must appear exactly late-forties. Preserve distinguished graying temples, natural forehead lines, crow's feet, nasolabial folds, slight jowl definition, and mature skin laxity. Forbidden: age regression, gray hair removal, wrinkle flattening, skin lifting, brightness injection.";

  const genderHint =
    gender === "male"
      ? "Masculine presentation: preserve Adam's apple visibility, brow bossing, facial hair density, and masculine skin texture without exaggeration."
      : gender === "female"
      ? "Feminine presentation: preserve lip vermillion definition, lash density, and feminine bone structure without artificial enhancement."
      : "Gender presentation faithfully mirrored from references without stereotyping or exaggeration.";

  return `Demographics: ${ageLock} ${genderHint}`;
}

function buildV10Prompt(
  gender: Gender,
  styleId: StyleId,
  ageTier: AgeTier,
  mode: PromptType,
  index: number,
): string {
  const styleBlock = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const demographics = describeDemographics(gender, ageTier);

  // Composition layer — shared across tiers, identity is non-negotiable
  const composition =
    `${IDENTITY_CORE} ${demographics} Framing: ${framing}. ` +
    `Subject: ${styleBlock.subject}. ` +
    `Environment: ${styleBlock.environment}. ` +
    `Mood: ${styleBlock.mood}. `;

  // Aesthetic layer — differentiates Free vs Premium in optical depth only
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
  const positivePrompt = buildV10Prompt(gender, styleId, ageTier, mode, index);
  const negativePrompt = buildNegativePrompt(mode);

  const debugPromptParts: DebugPromptParts = {
    version: "V10-LikenessLock",
    styleId,
    mode,
    gender,
    ageTier,
    index,
  };

  console.log(
    `[PROMPT V10-LikenessLock] style=${styleId} mode=${mode} gender=${gender} age=${ageTier} idx=${index}`,
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
