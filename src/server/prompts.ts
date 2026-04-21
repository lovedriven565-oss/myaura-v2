// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V6.0 — Prompt Architecture
// ═════════════════════════════════════════════════════════════════════════════
//
// Two strictly separated builders, one per tier:
//
//   buildFreePrompt(styleId, index)
//     Formulaic, concise. No identity locks, no texture modules.
//     Shape: "A cinematic portrait of the person in the style of <Style>.
//            <Environment>. High resolution, 4k, masterpiece, super details."
//
//   buildPremiumPrompt(styleId, index)
//     Identity Lock Module (PREPENDED) +
//     <Style> Subject + <Environment> + <Mood> +
//     Texture Injection Module (APPENDED).
//
// The Identity Lock instructs the model to preserve the subject referenced
// by the Subject Customization API (`referenceImages` in ai.ts). The Texture
// Injection locks natural skin micro-detail so outputs stay photorealistic
// rather than drifting to CGI.
// ═════════════════════════════════════════════════════════════════════════════

export type PromptTier = "free" | "premium";

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

// Retained for signature compatibility with the rest of the codebase. The
// V6.0 prompt builders no longer branch on age/gender — the model preserves
// those automatically from the Subject Customization references.
export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";

// Back-compat alias: callers still import `PromptType`.
export type PromptType = PromptTier;

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

// ─── Style blocks ──────────────────────────────────────────────────────────
// Each style provides:
//   label       : short identifier used in the FREE-tier formula
//   subject     : clothing / posture descriptor (PREMIUM only)
//   environment : background / lighting descriptor
//   mood        : overall emotional/colour tone (PREMIUM only)

interface StyleBlock {
  label: string;
  subject: string;
  environment: string;
  mood: string;
}

const STYLE_BLOCKS: Record<StyleId, StyleBlock> = {
  business: {
    label: "professional business",
    subject: "sharply tailored dark suit, crisp white shirt, composed professional posture",
    environment: "modern glass-walled corporate office, soft diffused north-window light, subtle architectural bokeh",
    mood: "confident, authoritative, quietly powerful",
  },
  lifestyle: {
    subject: "neutral-tone cashmere knitwear, softly tailored casuals, natural relaxed posture",
    label: "warm lifestyle",
    environment: "warm golden-hour outdoor setting, gentle lens flare, creamy background blur",
    mood: "approachable, candid, effortlessly elegant",
  },
  cinematic: {
    label: "cinematic film",
    subject: "dark structured clothing, contemplative gaze slightly off-camera",
    environment: "low-key studio, practical tungsten backlights, atmospheric haze",
    mood: "moody, intense, film-noir restraint, teal-and-orange grading",
  },
  editorial: {
    label: "editorial magazine",
    subject: "bold avant-garde silhouette, striking editorial pose",
    environment: "seamless minimal paper-backdrop studio, overhead beauty dish, fill reflector",
    mood: "high-contrast, magazine-cover confidence, gallery-grade composition",
  },
  luxury: {
    label: "luxury heritage",
    subject: "bespoke silk, fine merino layering, subtle gold accents",
    environment: "grand private library or hotel suite, warm ambient reading lamps, antique texture",
    mood: "quiet wealth, understated sophistication, heritage elegance",
  },
  aura: {
    label: "ethereal aura",
    subject: "flowing translucent fabric catching the light",
    environment: "abstract backdrop, soft volumetric light rays, iridescent colour shifts",
    mood: "ethereal, dreamlike, fine-art dream-pop",
  },
  cyberpunk: {
    label: "cyberpunk neon",
    subject: "sleek techwear jacket, subtle neon piping, sharp silhouette",
    environment: "neon-drenched night cityscape, rain reflections, atmospheric haze, purple-and-cyan signage bokeh",
    mood: "futuristic, kinetic, blade-runner atmosphere",
  },
  corporate: {
    label: "formal corporate",
    subject: "conservative dark suit, minimal styling, neutral posture",
    environment: "modern office backdrop, neutral lighting, clean background, subtle desk detail",
    mood: "professional, understated, formal",
  },
  ethereal: {
    label: "painterly ethereal",
    subject: "diaphanous pale fabric, serene expression, gentle chiaroscuro on the face",
    environment: "soft misted studio, morning god-rays through dust particles, pastel gradient backdrop",
    mood: "celestial, painterly, Renaissance fresco sensibility",
  },
};

// ─── Framing variety (stops every output looking identical) ────────────────
const FRAMINGS = [
  "centered frontal portrait",
  "subtle 3/4 angle portrait",
  "medium close-up portrait",
  "head-and-shoulders portrait",
  "environmental portrait with background depth",
  "relaxed posture three-quarter portrait",
];

// ─── V6.0 Identity Lock Module (PREMIUM only, prepended) ───────────────────
const IDENTITY_LOCK_MODULE =
  "Using the provided reference photos, preserve the 100% exact facial geometry, " +
  "bone structure, skin tone, and unique identifiers of the person. Do not alter " +
  "the subject's identity, proportions, or age. Match the face unchanged with " +
  "realistic skin texture, natural imperfections, and high-fidelity photorealism.";

// ─── V6.0 Texture Injection Module (PREMIUM only, appended) ────────────────
const TEXTURE_INJECTION_MODULE =
  "Ultra-detailed macro skin rendering: visible natural pores and fine lines. " +
  "Soft diffused side lighting that reveals micro-detail without harsh shadows. " +
  "Sharp focus on skin surface with gentle depth falloff. No retouching, no " +
  "foundation — raw, natural skin with realistic subsurface scattering.";

// ─── V6.1 Photorealism Anchor (both tiers, prepended) ────────────────────────
const PHOTO_REALISM_ANCHOR =
  "Live-action cinematography, hyper-realistic photography of a real human being, " +
  "shot on 85mm lens, realistic skin texture. The subject is in a ";

// ─── V6.1 Negative Prompt (blocks CGI/cartoon generation) ───────────────────
export const NEGATIVE_PROMPT =
  "cartoon, 3d render, CGI, anime, illustration, painting, digital art, video game graphics, plastic skin, doll, artificial, stylized, caricature";

// ─── FREE tier (formulaic, fast) ───────────────────────────────────────────
/**
 * "A cinematic portrait of the person in the style of [Style]. [Environment].
 *  High resolution, 4k, masterpiece, super details."
 */
export function buildFreePrompt(styleId: StyleId, index: number = 0): string {
  const block = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = FRAMINGS[index % FRAMINGS.length];
  return (
    PHOTO_REALISM_ANCHOR +
    `${block.environment} environment. ` +
    `A cinematic ${framing} of the person. ` +
    `High resolution, 4k, photorealistic details.`
  );
}

// ─── PREMIUM tier (Identity Lock + Style + Texture Injection) ──────────────
export function buildPremiumPrompt(styleId: StyleId, index: number = 0): string {
  const block = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = FRAMINGS[index % FRAMINGS.length];

  const style = [block.subject, block.environment, block.mood].join(", ");

  return [
    PHOTO_REALISM_ANCHOR + `${block.environment} environment.`,
    IDENTITY_LOCK_MODULE,
    `${framing}, ${style}.`,
    TEXTURE_INJECTION_MODULE,
  ].join(" ");
}

// ─── Unified dispatcher ────────────────────────────────────────────────────
export function buildPrompt(tier: PromptTier, styleId: StyleId, index: number = 0): string {
  return tier === "premium"
    ? buildPremiumPrompt(styleId, index)
    : buildFreePrompt(styleId, index);
}

// ─── Style gating (UI + server validation) ─────────────────────────────────
export function getAvailableStyles(tier: PromptTier): readonly StyleId[] {
  return tier === "premium" ? [...CORE_STYLES, ...PREMIUM_EXCLUSIVE_STYLES] : CORE_STYLES;
}

export function isPremiumOnlyStyle(styleId: StyleId): boolean {
  return PREMIUM_EXCLUSIVE_STYLES.includes(styleId);
}
