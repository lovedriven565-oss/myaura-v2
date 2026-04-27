// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V7.0 — Prompt Architecture (S-Tier Photorealism, Profile-Anchored)
// ═════════════════════════════════════════════════════════════════════════════
//
// V7.0 changes:
//   - Stylistic words that pull the model toward CGI/illustration attractor
//     basins have been scrubbed ("fine-art", "editorial composition",
//     "painterly", "masterpiece" — gone).
//   - Profile-aware builders inject a biometric identity header at the front
//     of every prompt so identity tokens are anchored before style tokens.
//   - NEGATIVE_PROMPT expanded with explicit CGI/3D/render/illustration kills.
//
// The identity header is built from a SubjectProfile produced by the
// preflight audit (see biometric.ts) merged with user-supplied gender/age.
// ═════════════════════════════════════════════════════════════════════════════

import type { SubjectProfile } from "./biometric.js";
import { buildIdentityHeader } from "./biometric.js";

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

export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";
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

// ─── V7.0 Negative prompt (CGI/cartoon kill list) ──────────────────────────
// Order matters less than coverage. We enumerate every common attractor that
// the model drifts toward when given a portrait task without strong photo
// anchoring. Tested against gemini-3.1-flash-image-preview and Imagen 3.
export const NEGATIVE_PROMPT =
  "3D render, CGI, computer graphics, cartoon, anime, illustration, drawing, painting, " +
  "digital painting, oil painting, watercolor, sketch, concept art, character design, " +
  "video game, game character, octane render, unreal engine, cinema 4d, blender, zbrush, " +
  "plastic skin, waxy skin, airbrushed, over-smoothed, beauty filter, instagram filter, " +
  "glossy doll skin, porcelain skin, uncanny valley, mannequin, action figure, statue, " +
  "caricature, exaggerated features, idealized features, distorted face, deformed face, " +
  "asymmetric eyes, extra fingers, fused fingers, extra limbs, masterpiece, artstation";

// ─── V7.0 Photographic anchor (the absolute frame) ─────────────────────────
// Sets the frame to PHOTOGRAPHY before any style-specific words can drag the
// model into illustration territory. Concrete camera/lens specs work better
// than buzzwords ("masterpiece" is now in the negative prompt).
const GLOBAL_PHOTO_ANCHOR =
  "Real photograph, captured on a full-frame DSLR, 85mm lens at f/1.8, " +
  "natural skin texture with visible pores and micro-imperfections, no retouching, " +
  "believable photographic depth-of-field, true-to-life color science. The subject is in a ";

// ─── Style blocks ──────────────────────────────────────────────────────────
interface StyleBlock {
  label: string;
  subject: string;
  environment: string;
  mood: string;
}

const STYLE_BLOCKS: Record<StyleId, StyleBlock> = {
  business: {
    label: "professional business environment",
    subject: "sharply tailored dark suit, crisp white shirt, composed professional posture",
    environment: "modern glass-walled corporate office, soft diffused north-window light, subtle architectural bokeh",
    mood: "confident, authoritative, quietly powerful",
  },
  lifestyle: {
    label: "warm lifestyle setting",
    subject: "neutral-tone cashmere knitwear, softly tailored casuals, natural relaxed posture",
    environment: "warm golden-hour outdoor setting, gentle lens flare, creamy background blur",
    mood: "approachable, candid, effortlessly elegant",
  },
  cinematic: {
    label: "cinematic film set",
    subject: "dark structured clothing, contemplative gaze slightly off-camera",
    environment: "low-key set with practical tungsten backlights, atmospheric haze",
    mood: "moody, restrained, photographed on a film stock with natural grain",
  },
  editorial: {
    label: "magazine cover photoshoot",
    subject: "bold tailored silhouette, striking confident pose",
    environment: "seamless paper-backdrop studio, overhead beauty dish, white fill reflector",
    mood: "high-contrast, confident, sharp studio lighting captured by a 35mm camera",
  },
  luxury: {
    label: "luxury heritage setting",
    subject: "bespoke silk, fine merino layering, subtle gold accents",
    environment: "grand private library or hotel suite, warm ambient reading lamps, antique texture",
    mood: "quiet wealth, understated sophistication, heritage elegance",
  },
  aura: {
    label: "soft directional studio lighting setup",
    subject: "flowing translucent fabric catching the light",
    environment: "neutral gradient backdrop, soft volumetric light rays, gentle haze",
    mood: "serene, softly lit, photographed with a portrait lens",
  },
  cyberpunk: {
    label: "neon-lit night city",
    subject: "sleek techwear jacket, subtle neon piping, sharp silhouette",
    environment: "neon-drenched night cityscape, rain reflections, atmospheric haze, purple-and-cyan signage bokeh",
    mood: "futuristic, kinetic, realistic night photography",
  },
  corporate: {
    label: "formal corporate setting",
    subject: "conservative dark suit, minimal styling, neutral posture",
    environment: "modern office backdrop, neutral lighting, clean background, subtle desk detail",
    mood: "professional, understated, formal",
  },
  ethereal: {
    label: "soft romantic photography setup",
    subject: "diaphanous pale fabric, serene expression, gentle chiaroscuro on the face",
    environment: "soft misted studio, morning god-rays through dust particles, neutral gradient backdrop",
    mood: "serene, soft-focus, real photographic capture on a wide-aperture lens",
  },
};

const FRAMINGS = [
  "centered frontal portrait",
  "subtle 3/4 angle portrait",
  "medium close-up portrait",
  "head-and-shoulders portrait",
  "environmental portrait with background depth",
  "relaxed posture three-quarter portrait",
];

// ─── V7.0 Identity Lock Module ─────────────────────────────────────────────
const IDENTITY_LOCK_MODULE =
  "Using the provided reference photos, preserve the 100% exact facial geometry, " +
  "bone structure, skin tone, and unique identifiers of the person. Do not alter " +
  "the subject's identity, proportions, or age. Match the face unchanged with " +
  "realistic skin texture, natural imperfections, and high-fidelity photorealism. " +
  "This is a photograph, not an illustration.";

// ─── V7.0 Texture Injection Module ─────────────────────────────────────────
const TEXTURE_INJECTION_MODULE =
  "Ultra-detailed macro skin rendering: visible natural pores, fine lines, and " +
  "subtle skin imperfections. Soft diffused light reveals micro-detail without " +
  "harsh shadows. Sharp focus on skin surface with gentle depth falloff. No " +
  "retouching, no foundation, no beauty filter — raw natural skin with realistic " +
  "subsurface scattering as captured by a real camera sensor.";

// ─── FREE tier ─────────────────────────────────────────────────────────────
/**
 * `profile` is optional: if the audit produced one, we inject the identity
 * header at the front so the Flash model has the same biometric anchor as
 * Imagen does. Without it we still produce a sensible photo-anchored prompt.
 */
export function buildFreePrompt(
  styleId: StyleId,
  index: number = 0,
  profile: SubjectProfile | null = null,
): string {
  const block = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = FRAMINGS[index % FRAMINGS.length];
  const identity = profile ? `${buildIdentityHeader(profile)} ` : "";

  return (
    `${identity}${GLOBAL_PHOTO_ANCHOR}${block.label}. ` +
    `Subject is a ${framing}. ${block.environment}. ` +
    `\n\nDO NOT GENERATE: ${NEGATIVE_PROMPT}`
  );
}

// ─── PREMIUM tier ──────────────────────────────────────────────────────────
export function buildPremiumPrompt(
  styleId: StyleId,
  index: number = 0,
  profile: SubjectProfile | null = null,
): string {
  const block = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = FRAMINGS[index % FRAMINGS.length];

  const style = [block.subject, block.environment, block.mood].join(", ");
  const identity = profile ? buildIdentityHeader(profile) : "";

  const basePrompt = [
    identity,
    GLOBAL_PHOTO_ANCHOR + block.label + ".",
    IDENTITY_LOCK_MODULE,
    `${framing}, ${style}.`,
    TEXTURE_INJECTION_MODULE,
  ].filter(Boolean).join(" ");

  return `${basePrompt}\n\nDO NOT GENERATE: ${NEGATIVE_PROMPT}`;
}

export function buildPrompt(
  tier: PromptTier,
  styleId: StyleId,
  index: number = 0,
  profile: SubjectProfile | null = null,
): string {
  return tier === "premium"
    ? buildPremiumPrompt(styleId, index, profile)
    : buildFreePrompt(styleId, index, profile);
}

export function getAvailableStyles(tier: PromptTier): readonly StyleId[] {
  return tier === "premium" ? [...CORE_STYLES, ...PREMIUM_EXCLUSIVE_STYLES] : CORE_STYLES;
}

export function isPremiumOnlyStyle(styleId: StyleId): boolean {
  return PREMIUM_EXCLUSIVE_STYLES.includes(styleId);
}