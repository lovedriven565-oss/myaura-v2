export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";

// ─── Identity Lock Header ────────────────────────────────────────────────────
// Placed FIRST in every prompt — before mode, before style.
const IDENTITY_LOCK_HEADER = `PRIORITY 0 — IDENTITY IS NON-NEGOTIABLE:
This is a portrait generation of a SPECIFIC REAL PERSON shown in the reference photo(s).
Preserve this person's facial identity COMPLETELY: face shape, proportions, ethnicity, age appearance, skin tone, eye shape, nose, lips, jawline — UNCHANGED.
Style transformations apply ONLY to clothing, lighting, background, atmosphere, and pose.
NEVER reconstruct, reshape, idealize, slim, sharpen, or alter the face in any way.`;

// ─── Style Risk Guards ───────────────────────────────────────────────────────
// Appended after the style modifier block for medium and high-risk styles.
const MEDIUM_RISK_IDENTITY_GUARD = `IDENTITY PRESERVATION REMINDER: The elegant or atmospheric aesthetic of this style MUST NOT lead to skin over-smoothing, facial softening beyond realism, or subtle drift toward a more conventionally attractive archetype. Preserve exact facial character, natural pore texture, and this person's authentic facial structure.`;

const HIGH_RISK_IDENTITY_GUARD = `IDENTITY OVERRIDE — ABSOLUTE HARD CONSTRAINT: The dramatic or fashion-forward aesthetic of this style MUST NOT cause jaw sharpening, cheek hollowing from shadow, bone structure exaggeration, nose narrowing, increased under-eye darkness, or any drift toward a generic cinematic / editorial face archetype. This person's face geometry is a fixed non-negotiable constraint. Style is subordinate to identity.`;

const BASE_IDENTITY_PROMPT = `
CRITICAL IDENTITY REQUIREMENTS:
- Preserve EXACT facial geometry, proportions, and recognizable face structure.
- Preserve ethnicity, gender presentation, and natural age appearance.
- Preserve exact skin tone and natural skin tone variation.
- Preserve eye shape, natural eye spacing, iris color, and realistic eye detail.
- Preserve natural facial fullness. Do NOT create a hollow or gaunt face effect.
- Maintain sharp detail around eyes, nose, lips, and central facial features.
- Do NOT perform face replacement, face reshaping, artificial rejuvenation, or beauty-filter smoothing.

EXPRESSION / MOOD CONTROL:
- Create a calm, confident, approachable expression.
- Ensure a relaxed jawline, resting facial muscles, and lively eyes with catchlights.
- Maintain subtle magnetic confidence and natural facial softness.
- DO NOT create a sad, tense, tired, or stern passport-like expression.
- DO NOT create compressed lips, a downturned mouth, or a hardened older-looking expression.

SKIN CLEANUP POLICY:
- Create photorealistic epidermal detail, visible pores, and realistic micro texture.
- Maintain healthy healed skin without smoothing filters; clean premium skin without waxiness.
- Remove ONLY temporary acne, pimples, inflamed breakouts, temporary redness, and transient blemishes.
- NEVER erase pores, micro-texture, real skin contours, natural skin tone variation, freckles, or permanent recognizable facial character.
`;

const QUALITY_CONSTRAINTS = `
STRICT AVOIDANCE (CRITICAL):
- NO plastic skin, waxiness, airbrushed beauty filters, or porcelain texture.
- NO artificial rejuvenation, childification, or exaggerated youth effect.
- NO acne, pimples, active inflamed blemishes, or temporary breakouts.
- NO generic AI face, face reshaping, identity drift, face slimming, jaw sharpening, altered nose, changed eye spacing, altered hairline, or model-face substitution.
- NO sad, gloomy, tense, or emotionally flat expressions.
- NO uncanny eyes, distorted eye shape, unnatural reflections, or tired narrowed eyes.
- NO harsh aging from dramatic lighting, no excessive under-eye darkness, no exaggerated nasolabial shadows.
- NO extreme blur or depth-of-field that softens the face too much.
`;

const FREE_PREVIEW_LAYER = `
PREVIEW RESULT REQUIREMENTS:
Create a clean, flattering, trustworthy premium-looking portrait preview.
The person must look like the best realistic version of themselves.
WARDROBE: Mild clothing refinement at most. Use basic minimalist flattering clothing. NO major wardrobe change.
Use soft flattering portrait lighting that improves the face without dramatic contrast.
The result must feel polished, attractive, and sell the premium quality without over-retouching.

PREVIEW VISUAL DIRECTION:
Soft clean studio or daylight-balanced lighting, natural premium portrait, fresh and approachable. Not cinematic, not harsh, not flat ID/passport-like.
`;

const PREMIUM_LAYER = `
PREMIUM RESULT REQUIREMENTS:
Create a premium, high-end style-faithful portrait photoshoot.
WARDROBE TRANSFORMATION IS MANDATORY: You MUST completely change the subject's clothing to match the specific style instructions below. Do NOT keep the original input clothing.
The result must feel expensive, refined, realistic, and highly detailed.
The face MUST remain the same exact person as in the reference photo. Style transformation applies ONLY to clothing, lighting, background, and pose. Do NOT reconstruct, slim, sharpen, or idealize the face to match the style aesthetic.
`;

interface StyleConfig {
  promptModifier: string;
  negativePrompt: string; // explicitly appended to the main prompt
  retouchPolicy: string;
  lightingPolicy: string;
  styleRisk: "safe" | "medium" | "high";
}

export const PROMPT_STYLES_V2: Record<StyleId, StyleConfig> = {
  "business": {
    promptModifier: "WARDROBE: High-end tailored corporate suit, crisp collar, expensive fabric. STYLE: confident, refined, approachable professional presence. Strong but friendly, clean premium skin without temporary blemishes, healthy polished appearance, balanced studio light that flatters the face.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO cold corporate passport look, NO overly stiff or gray lifeless face, NO age exaggeration from seriousness.",
    retouchPolicy: "natural_texture",
    lightingPolicy: "controlled_soft_studio",
    styleRisk: "safe"
  },
  "lifestyle": {
    promptModifier: "WARDROBE: Elegant expensive casual wear, light breathable premium fabrics, effortless chic. STYLE: natural premium lifestyle portrait, soft natural daylight, elegant expensive environment, attractive but authentic real-person look, fresh natural appearance.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO influencer filter look, NO fake glossy skin, NO over-retouched casual portrait.",
    retouchPolicy: "clean_natural",
    lightingPolicy: "soft_daylight",
    styleRisk: "safe"
  },
  "cinematic": {
    promptModifier: "WARDROBE: Textured cinematic outerwear, dark moody fabrics, stylish layers. STYLE: cinematic premium portrait with controlled chiaroscuro — preserve full facial detail even in shadow areas. Cinematic confidence without sadness or fatigue. Avoid shadow placement that creates cheek hollowing, under-eye darkening, or bone structure exaggeration. Apply cinematic lighting and wardrobe WITHOUT altering jaw shape, nose, cheek depth, or any facial bone structure.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO tired under-eye darkness, NO villain energy, NO harsh aging from shadows, NO hollow cheeks, NO shadow-induced facial reconstruction, NO older harder version of the person.",
    retouchPolicy: "micro_contrast",
    lightingPolicy: "dramatic_cinematic",
    styleRisk: "high"
  },
  "editorial": {
    promptModifier: "WARDROBE: Avant-garde fashion styling, bold architectural garments, high-end magazine wardrobe. STYLE: high-end editorial portrait — editorial styling applies ONLY to wardrobe, lighting, and composition. Controlled premium retouch, sharp eyes, photorealistic epidermal detail, polished editorial finish without beauty filter, premium studio lighting. The face MUST stay 100% authentic to the reference person. Do NOT drift toward a generic fashion model or editorial archetype face.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO cheap glamour look, NO wax skin, NO over-airbrushed magazine face, NO face reconstruction toward model archetype, NO angular sharpening of facial structure.",
    retouchPolicy: "editorial_clean",
    lightingPolicy: "editorial_studio",
    styleRisk: "high"
  },
  "luxury": {
    promptModifier: "WARDROBE: Expensive designer evening wear or ultra-premium smart casual, rich textures (silk, cashmere). STYLE: elegant luxury portrait, expensive, elegant, refined visual language, sophisticated light, tactile organic skin finish, high-status styling with realistic face detail. Apply luxury styling WITHOUT refining or sharpening facial structure to appear more aristocratic.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO pristine porcelain skin, NO fake flawless skin, NO exaggerated glam filter, NO skin smoothing that erases natural texture.",
    retouchPolicy: "refined_clean",
    lightingPolicy: "luxury_soft",
    styleRisk: "medium"
  },
  "aura": {
    promptModifier: "WARDROBE: Ethereal flowing fabrics, soft elegant drapes, artistic minimalist styling. STYLE: dreamy atmosphere but sharp face and clear eyes. Soft glowing background aura, glow in background / atmosphere ONLY (never over the face), clean premium skin with micro texture, beautiful mood.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO soft-focus blur on face, NO smeared skin, NO dreamy plastic face, NO glow over facial features, NO face softening beyond natural realism.",
    retouchPolicy: "soft_glow",
    lightingPolicy: "aura_diffused",
    styleRisk: "medium"
  }
};

export function buildPromptProfile(styleId: StyleId, mode: PromptType, index: number = 0): { positivePrompt: string; negativePrompt: string; debugPromptParts: any } {
  const isPremium = mode === "premium";
  const layerPrompt = isPremium ? PREMIUM_LAYER : FREE_PREVIEW_LAYER;
  const styleConfig = PROMPT_STYLES_V2[styleId] || PROMPT_STYLES_V2["business"];

  // Controlled Variety Strategy for Premium batches
  let varietyModifier = "";
  if (isPremium) {
    const varietyAngles = [
      "Medium close-up portrait, straight on, balanced framing.",
      "Slightly angled shoulder, cinematic portrait crop.",
      "Medium shot, showing slightly more torso, relaxed confident posture.",
      "Tighter facial crop, intense editorial focus.",
      "Environmental portrait, slightly wider framing showing more background context.",
      "Slight 3/4 angle, elegant natural pose."
    ];
    varietyModifier = `\nVARIATION INSTRUCTION: ${varietyAngles[index % varietyAngles.length]}`;
  }

  // Style risk guard: appended after style modifier for medium/high-risk styles
  const styleRiskGuard = styleConfig.styleRisk === "high"
    ? HIGH_RISK_IDENTITY_GUARD
    : styleConfig.styleRisk === "medium"
    ? MEDIUM_RISK_IDENTITY_GUARD
    : "";

  // Explicitly merge style-specific negative constraints into the main prompt
  const dynamicQualityConstraints = QUALITY_CONSTRAINTS.trim() + "\n" +
    (mode === "free" ? "- NO passport-photo flatness for preview mode.\n" : "") +
    `- ${styleConfig.negativePrompt}`;

  const debugPromptParts = {
    identityLockHeader: IDENTITY_LOCK_HEADER.trim(),
    identityCore: BASE_IDENTITY_PROMPT.trim(),
    layerMode: layerPrompt.trim(),
    styleModifier: styleConfig.promptModifier,
    retouchPolicy: styleConfig.retouchPolicy,
    lightingPolicy: styleConfig.lightingPolicy,
    styleRiskGuard: styleRiskGuard.trim(),
    varietyModifier: varietyModifier.trim(),
    qualityConstraints: dynamicQualityConstraints
  };

  const finalPrompt = [
    debugPromptParts.identityLockHeader,    // Identity lock: FIRST, always
    debugPromptParts.identityCore,
    debugPromptParts.layerMode,
    "SPECIFIC STYLE INSTRUCTIONS:",
    `Apply lighting: ${debugPromptParts.lightingPolicy}`,
    `Apply retouch: ${debugPromptParts.retouchPolicy}`,
    `Style elements: ${debugPromptParts.styleModifier}`,
    debugPromptParts.styleRiskGuard,        // Risk guard: after style, before variety
    debugPromptParts.varietyModifier,
    debugPromptParts.qualityConstraints
  ].filter(Boolean).join("\n\n");

  const finalNegativePrompt = "ugly, deformed, poorly drawn, bad anatomy, bad lighting, low resolution, blurry, watermark, text, amateur photography, " + styleConfig.negativePrompt;

  return {
    positivePrompt: finalPrompt,
    negativePrompt: finalNegativePrompt,
    debugPromptParts
  };
}

// Legacy adapter for existing code
export function buildPrompt(type: PromptType, styleId: StyleId, index: number = 0): { prompt: string; negativePrompt: string } {
  const profile = buildPromptProfile(styleId, type, index);
  return {
    prompt: profile.positivePrompt,
    negativePrompt: profile.negativePrompt
  };
}
