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

// ─── V12 "Geometry Lock" Architecture ──────────────────────────────────────
//
// Design philosophy:
//   1. CAMERA-FIRST MEDIUM OVERRIDE. The very first tokens force the model into
//      "raw photo" mode: "Authentic candid photograph, raw unretouched skin
//      texture, visible pores, natural facial imperfections, direct flash lighting,
//      extremely high detail". This kills the plastic/CGI bias at token 0.
//
//   2. STRICT GEOMETRY ANCHORS in CAPS. PRESERVE EXACT HAIRCUT GEOMETRY AND
//      TEXTURE FROM REFERENCE is an all-caps mandate that overrides the model's
//      tendency to standardise hairstyles per style (e.g. Corporate).
//
//   3. PUNCHY COMMA-SEPARATED KEYWORDS only. No flowing sentences, no narrative
//      descriptions. Each tag is a discrete visual constraint the model parses
//      independently. This prevents "reasoning" the face into a beauty filter.
//
//   4. COMPRESSED NEGATIVE PROMPT. Only the critical anti-plastic anchors remain:
//      altered face geometry, smooth skin, beauty filter, different haircut.
//      Vertex AI parses short negative lists more reliably than long litanies.

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

// ── V12 Medium Override: forces "photo" mode at token 0 ───────────────────
const MEDIUM_OVERRIDE =
  "Authentic candid photograph, raw unretouched skin texture, visible pores, natural facial imperfections, " +
  "direct flash lighting, extremely high detail";

// ── V12 Identity Anchors: strict geometry fixation ────────────────────────
function buildGeometryLock(ageTier: AgeTier): string {
  const ageLock =
    ageTier === "young"
      ? "young adult age lock"
      : ageTier === "mature"
      ? "mature adult age lock"
      : "distinguished adult age lock";

  return [
    "Extreme facial likeness to reference",
    "strict adherence to reference facial bone structure",
    "preserve original jawline geometry and cheekbone height",
    "PRESERVE EXACT HAIRCUT GEOMETRY AND TEXTURE FROM REFERENCE",
    "no hair volume alteration",
    ageLock,
  ].join(", ");
}

// ── V12 Demographics: gender + expression + catchlights only ─────────────────
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

// ── V12 Negative Prompt: compressed critical anchors only ──────────────────
const NEGATIVE_PROMPT =
  "different person, smooth skin, beauty filter, altered face geometry, different haircut, " +
  "different hair texture, extra hair volume, plastic face, CGI, 3D render, cartoon, " +
  "digital makeup, teeth whitening, jawline sharpening, asymmetry correction, over-optimization";

function buildV12Prompt(
  gender: Gender,
  styleId: StyleId,
  ageTier: AgeTier,
  _mode: PromptType,
  index: number,
): string {
  const styleBlock = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const geometryLock = buildGeometryLock(ageTier);
  const demographics = buildDemographics(gender, ageTier);

  // V12 cascade: Medium Override → Geometry Lock → Demographics → Framing → Subject → Environment → Mood
  return [
    MEDIUM_OVERRIDE,
    geometryLock,
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
): { positivePrompt: string; negativePrompt: string; debugPromptParts: DebugPromptParts } {
  const positivePrompt = buildV12Prompt(gender, styleId, ageTier, mode, index);
  const negativePrompt = buildNegativePrompt(mode);

  const debugPromptParts: DebugPromptParts = {
    version: "V12-GeometryLock",
    styleId,
    mode,
    gender,
    ageTier,
    index,
  };

  console.log(
    `[PROMPT V12-GeometryLock] style=${styleId} mode=${mode} gender=${gender} age=${ageTier} idx=${index}`,
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
