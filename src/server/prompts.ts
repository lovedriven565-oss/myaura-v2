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
  "acne, pimples, skin blemishes, skin spots, red spots, skin inflammation, " +
  "3D render, CGI, computer graphics, cartoon, anime, illustration, drawing, painting, " +
  "digital painting, oil painting, watercolor, sketch, concept art, character design, " +
  "video game, game character, octane render, unreal engine, cinema 4d, blender, zbrush, " +
  "waxy skin, airbrushed, over-smoothed, " +
  "glossy doll skin, porcelain skin, uncanny valley, mannequin, action figure, statue, " +
  "masterpiece, artstation, stock photo face";

// ─── V7.1 Photographic anchor (latent-space-conflict fix) ──────────────────
// Concrete optical-physics terms ("85mm lens at f/1.8, full-frame DSLR") were
// pulling outputs into the "idealized fashion model" attractor basin: glossy
// skin, perfect symmetry, magazine-grade subjects that no longer matched the
// uploaded person. We now anchor on candid, unedited, amateur photography
// language to shift the latent space toward authentic realism.
const GLOBAL_PHOTO_ANCHOR =
  "An unedited, candid photograph taken on a standard camera. " +
  "Natural, everyday lighting. Authentic, unretouched amateur photography. " +
  "The subject is in a ";

// V8.2: Premium Studio anchor. Blends high-end aesthetics with authentic detail.
const PREMIUM_PHOTO_ANCHOR =
  "A high-end professional studio portrait photograph. " +
  "Perfectly balanced professional lighting with soft shadows. " +
  "Captured on a medium format camera for maximum detail and depth. " +
  "The subject is in a ";

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
    subject: "sharply tailored suit, crisp shirt",
    environment: "modern glass-walled corporate office, natural window light, subtle architectural bokeh",
    mood: "natural, warm, approachable",
  },
  lifestyle: {
    label: "warm lifestyle setting",
    subject: "neutral-tone cashmere knitwear, softly tailored casuals, natural relaxed posture",
    environment: "warm golden-hour outdoor setting, gentle lens flare, creamy background blur",
    mood: "approachable, candid, effortlessly elegant",
  },
  cinematic: {
    label: "cinematic film set",
    subject: "dark structured clothing, natural gaze",
    environment: "dimly lit room, practical lamps, authentic atmosphere",
    mood: "atmospheric, naturally lit, photographed on a film stock with natural grain",
  },
  editorial: {
    label: "magazine cover photoshoot",
    subject: "tailored silhouette, natural pose",
    environment: "seamless paper-backdrop, simple natural light",
    mood: "clean lighting captured by a 35mm camera",
  },
  luxury: {
    label: "luxury heritage setting",
    subject: "bespoke silk, fine merino layering, subtle gold accents",
    environment: "grand private library or hotel suite, warm ambient reading lamps, antique texture",
    mood: "understated sophistication, warm heritage elegance",
  },
  aura: {
    label: "soft directional setup",
    subject: "flowing translucent fabric catching the light",
    environment: "neutral gradient backdrop, natural ambient lighting",
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
    environment: "soft misted room, morning natural light, neutral gradient backdrop",
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

// ─── V7.0 Texture Injection Module ─────────────────────────────────────────
const TEXTURE_INJECTION_MODULE =
  "Clean, smooth professional skin texture with subtle natural glow. " +
  "Balanced studio lighting reveals clear facial features. " +
  "Sharp focus on the face with elegant depth of field. " +
  "Flawless natural skin as captured by a professional medium format sensor.";

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
    `${identity}Critically: You must extract the person from the reference image and place them in a COMPLETELY NEW environment with NEW clothing. DO NOT keep the original background or outfit. ` +
    `${GLOBAL_PHOTO_ANCHOR}${block.label}. ` +
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
    "Critically: You must extract the person from the reference image and place them in a COMPLETELY NEW environment with NEW clothing. DO NOT keep the original background or outfit.",
    GLOBAL_PHOTO_ANCHOR + block.label + ".",
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

// ─── PREMIUM tier (Imagen 3 Subject Customization, V8.1) ───────────────────
/**
 * Builds the prompt template for Imagen 3 Subject Customization.
 *
 * V8.1 — Latent Space Conflict resolution:
 *   The previous version threaded biometric prose ("strong jawline, full lips,
 *   defined eyebrows") into both `subjectDescription` and the prompt body.
 *   This activated the text-encoder hard enough to *suppress* the visual
 *   embedding produced by SubjectReferenceImage, which is the entire reason
 *   Imagen 3 Subject Customization exists. Outcome: poor likeness, idealized
 *   "stock model" output that ignored the uploaded face.
 *
 * V8.1 fix:
 *   - subjectDescription is the SHORTEST POSSIBLE neutral noun phrase that
 *     keeps Imagen's [1] marker grammatically valid: "the exact person
 *     shown in the reference images". No biometrics. No gender. No age.
 *     The reference images carry that information natively.
 *   - The prompt body is candid-photography only, with no DSLR/lens jargon
 *     that would push outputs toward fashion-magazine attractor basins.
 *   - The negative prompt is passed separately via `config.negativePrompt`
 *     (Imagen 3 contract).
 *
 * The `[1]` marker MUST appear immediately after the subjectDescription —
 * Imagen replaces "${subjectDescription} [1]" with the locked identity at
 * attention time. Any drift in this contract degrades likeness.
 */
export const IMAGEN_NEUTRAL_SUBJECT = "the exact person shown in the reference images";

export function buildV9TunedPrompt(
  styleId: StyleId,
  index: number,
  profile: SubjectProfile | null,
): string {
  const block = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = FRAMINGS[index % FRAMINGS.length];
  
  // V9.0 uses the [V_TOK] default token from Vertex AI Subject Tuning
  const subjectToken = "[V_TOK] person";
  
  const prompt =
    `An unedited, candid photograph of ${subjectToken}. ` +
    `${block.label}. ${framing}. ${block.subject}. ${block.environment}. ` +
    `Natural, everyday lighting. Authentic, unretouched amateur photography. ` +
    `${TEXTURE_INJECTION_MODULE} ${block.mood}.`;

  return prompt;
}

export function buildPremiumImagenPrompt(
  styleId: StyleId,
  index: number,
  profile: SubjectProfile,
): { prompt: string; subjectDescription: string } {
  const block = STYLE_BLOCKS[styleId] || STYLE_BLOCKS.business;
  const framing = FRAMINGS[index % FRAMINGS.length];
  const subjectDescription = IMAGEN_NEUTRAL_SUBJECT;
  const subjectToken = `${subjectDescription} [1]`;

  const prompt =
    `${PREMIUM_PHOTO_ANCHOR}${subjectToken}. ` +
    `${block.label}. ${framing}. ${block.subject}. ${block.environment}. ` +
    `${TEXTURE_INJECTION_MODULE} ${block.mood}.`;

  return { prompt, subjectDescription };
}

export function getAvailableStyles(tier: PromptTier): readonly StyleId[] {
  return tier === "premium" ? [...CORE_STYLES, ...PREMIUM_EXCLUSIVE_STYLES] : CORE_STYLES;
}

export function isPremiumOnlyStyle(styleId: StyleId): boolean {
  return PREMIUM_EXCLUSIVE_STYLES.includes(styleId);
}