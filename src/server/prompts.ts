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

// ─── V11 "Tag Cascade" Architecture ────────────────────────────────────────
//
// Design philosophy:
//   Short comma-separated tags force the model into "photography" mode instead
//   of "CGI description" mode. No numbered lists, no all-caps mandates, no
//   long sentences. Just camera-first optical anchors followed by likeness tags.
//
//   FREE tier  → Clean tag cascade on Kodak-style film stock.
//                Enough skin and asymmetry tags to avoid plastic faces.
//
//   PREMIUM    → Full optical payload: sensor, lens, film grain, catchlights.
//                gemini-3-pro-image-preview reasons through the tag cloud.

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

// ── Style tag blocks: short comma-separated phrases only ────────────────────
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
    subject: "impeccable charcoal suit, conservative tie, hands composed, boardroom posture",
    environment: "Fortune-500 executive suite, floor-to-ceiling window skyline, brushed-metal desk details",
    mood: "CEO-tier authority, institutional trust, LinkedIn-executive polish",
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

// ── Camera-first optical anchors ────────────────────────────────────────────
const FREE_AESTHETIC_SUFFIX =
  "authentic candid photograph, shot on Kodak Portra 400, 85mm f/1.4 lens, ultra-detailed, " +
  "raw unedited photo, shallow depth of field, natural creamy bokeh, " +
  "visible skin pores, natural micro-texture, subtle subsurface scattering on ears and nose, " +
  "accurate daylight color science, no digital smoothing, no beauty filter, no AI gloss, " +
  "preserve every facial asymmetry, freckle, natural imperfection exactly as in the reference";

const PREMIUM_AESTHETIC_SUFFIX =
  "authentic candid photograph, shot on Sony A7 IV full-frame sensor, Sony GM 85mm f/1.4 prime lens at f/2.0, ultra-detailed, " +
  "raw unedited photo, shallow depth of field with creamy natural bokeh roll-off, " +
  "neutral daylight color science, accurate skin tone reproduction without warmth injection, subtle 35mm organic film grain, " +
  "hyper-realistic skin micro-texture, visible pores, fine vellus hair, natural sebum sheen on T-zone, subsurface scattering on ears nose cheeks, no plastic smoothing, no pore erasure, " +
  "asymmetric catchlights matching ambient source, preserved iris pattern detail, limbal ring thickness, correct sclera vascularity, anatomically correct hand articulation, knuckle definition, " +
  "no digital retouching, no frequency separation, no dodge and burn, no skin smoothing, no teeth whitening, no eye brightening, no jawline sharpening, no cheekbone enhancement, no lip plumping, " +
  "Vogue-tier composition, commercial-grade RAW fidelity, gallery-print micro-contrast";

// ── Simplified negative prompt (shared, no tier split) ─────────────────────
const NEGATIVE_PROMPT =
  "3D render, CGI, plastic, beauty filter, smooth skin, cartoon, different person, altered facial features, " +
  "changed eye color, distorted anatomy, extra fingers, malformed hands, text artifacts, watermarks, " +
  "symmetry correction, skin smoothing, pore erasure, baby face filter, age regression, age advancement, " +
  "wax complexion, synthetic hair, over-retouched porcelain, uncanny AI gloss, digital makeup, teeth whitening, " +
  "eye enlargement, lip plumping, cheekbone enhancement, jawline sharpening, rubber-band jawline, smeared irises, " +
  "blurred pores, porcelain doll effect, Instagram filter, Snapchat filter, frequency separation, dodge and burn";

// ── Identity core: likeness tags only ───────────────────────────────────────
const LIKENESS_TAGS =
  "exact facial likeness to reference, raw unedited skin texture, visible pores, natural facial asymmetry, " +
  "identical bone structure, preserved eye socket shape, brow ridge contour, nose bridge width and tip geometry, " +
  "lip fullness and Cupid's bow, jawline angle, chin projection, ear shape, " +
  "natural eye size differences, eyebrow height variance, nose deviation, jaw asymmetry, " +
  "exact pore density, natural sebum sheen, stubble pattern, acne, freckles, moles, scar tissue, " +
  "under-eye hollows, nasolabial fold depth, exact iris color and pattern, limbal ring thickness, " +
  "correct sclera vascularity, asymmetric catchlights matching ambient source";

function describeDemographics(gender: Gender, ageTier: AgeTier): string {
  const ageTags =
    ageTier === "young"
      ? "mid-twenties age lock, youthful skin texture, adult facial proportions, cheekbone height, jaw width, no baby-face filter, no cheek puffing, no oversized eyes, no reduced nose bridge, no lip plumping"
      : ageTier === "mature"
      ? "mid-thirties age lock, early expression lines, natural forehead texture, slight crow's feet, mature skin density, no youth filter, no wrinkle erasure, no skin tightening, no glow enhancement, no eye bag removal"
      : "late-forties age lock, distinguished graying temples, natural forehead lines, crow's feet, nasolabial folds, slight jowl definition, mature skin laxity, no age regression, no gray hair removal, no wrinkle flattening, no skin lifting, no brightness injection";

  const genderTags =
    gender === "male"
      ? "masculine presentation, Adam's apple visibility, brow bossing, facial hair density, masculine skin texture"
      : gender === "female"
      ? "feminine presentation, lip vermillion definition, lash density, feminine bone structure"
      : "gender presentation faithfully mirrored from references, no stereotyping, no exaggeration";

  return `${ageTags}, ${genderTags}`;
}

function buildV11Prompt(
  gender: Gender,
  styleId: StyleId,
  ageTier: AgeTier,
  mode: PromptType,
  index: number,
): string {
  const styleBlock = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const demographics = describeDemographics(gender, ageTier);

  // Camera-first tag cascade: camera, likeness, demographics, framing, subject, environment, mood, optical suffix
  return [
    mode === "premium" ? PREMIUM_AESTHETIC_SUFFIX : FREE_AESTHETIC_SUFFIX,
    LIKENESS_TAGS,
    demographics,
    framing,
    styleBlock.subject,
    styleBlock.environment,
    styleBlock.mood,
  ].join(", ");
}

function buildNegativePrompt(_mode: PromptType): string {
  // Simplified: one clean negative prompt for both tiers
  return NEGATIVE_PROMPT;
}

export function buildPromptProfile(
  styleId: StyleId,
  mode: PromptType,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset",
): { positivePrompt: string; negativePrompt: string; debugPromptParts: DebugPromptParts } {
  const positivePrompt = buildV11Prompt(gender, styleId, ageTier, mode, index);
  const negativePrompt = buildNegativePrompt(mode);

  const debugPromptParts: DebugPromptParts = {
    version: "V11-TagCascade",
    styleId,
    mode,
    gender,
    ageTier,
    index,
  };

  console.log(
    `[PROMPT V11-TagCascade] style=${styleId} mode=${mode} gender=${gender} age=${ageTier} idx=${index}`,
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
