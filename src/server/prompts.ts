export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";

const BASE_IDENTITY_PROMPT = `
CRITICAL REQUIREMENTS:
- Preserve EXACT facial identity from the original image.
- Preserve facial geometry, bone structure, and features exactly.
- Preserve age and gender presentation exactly as in the original.
- Preserve ethnicity and skin tone.
- Preserve natural skin texture (do NOT over-smooth, no plastic skin).
- Do NOT perform face replacement.
- Do NOT make the subject look like a child if they are an adult (no childification).
- Maintain realistic proportions.
`;

const QUALITY_CONSTRAINTS = `
NEGATIVE CONSTRAINTS: 
- No cartoonish looks, no 3D render style, no plastic skin.
- No extreme depth of field that blurs the subject's face.
- Avoid unnatural lighting artifacts or weird eye reflections.
`;

const FREE_PREVIEW_LAYER = `
STYLE TASK: Create a fast, safe, highly believable studio-style portrait.
Keep stylization minimal. The primary goal is to prove the AI can preserve likeness perfectly.
Lighting: Flat, neutral, professional studio lighting.
Background: Simple, neutral, non-distracting.
`;

const PREMIUM_LAYER = `
STYLE TASK: Create a premium, high-end, highly polished portrait.
This is a paid result. The image must look expensive, with richer light, deep colors, and magazine-quality finish.
The subject must look their absolute best while maintaining 100% likeness.
`;

const STYLE_PRESETS: Record<StyleId, string> = {
  business: "Business headshot style: Sharp suit, confident expression, high-end corporate studio lighting, neutral or modern office background.",
  lifestyle: "Premium lifestyle style: Natural soft sunlight, relaxed but elegant pose, high-end interior or blurred outdoor background.",
  aura: "Aura signature style: Soft, glowing ethereal light, subtle pastel color accents, highly aesthetic and moody, dreamy but realistic.",
  cinematic: "Cinematic style: Deep dramatic shadows, moody teal and orange or rich cinematic color grading, movie still quality.",
  luxury: "Luxury style: 'Old money' aesthetic, elegant evening wear or expensive casual wear, rich textures, luxurious environment.",
  editorial: "Studio Editorial style: High-fashion magazine cover look, striking dramatic flash lighting, vanguard styling, bold contrast."
};

export function buildPrompt(type: PromptType, styleId: StyleId): string {
  const isPremium = type === "premium";
  const layerPrompt = isPremium ? PREMIUM_LAYER : FREE_PREVIEW_LAYER;
  const stylePrompt = STYLE_PRESETS[styleId] || STYLE_PRESETS["business"];

  return [
    BASE_IDENTITY_PROMPT.trim(),
    layerPrompt.trim(),
    "SPECIFIC STYLE:",
    stylePrompt.trim(),
    QUALITY_CONSTRAINTS.trim()
  ].join("\n\n");
}
