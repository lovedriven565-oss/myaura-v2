export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";

// ─── Identity Lock Header ────────────────────────────────────────────────────
const IDENTITY_LOCK_HEADER = `[SYSTEM OVERRIDE: STRICT BIOMETRIC MATCH REQUIRED]
PRIORITY 0: This is a 1:1 photorealistic generation of a SPECIFIC REAL PERSON. 
You MUST maintain 100% biometric fidelity to the reference photo.
The output face MUST be geometrically identical to the input: exact face width, jawline shape, cheek fullness, nose proportions, and eye spacing.
ABSOLUTE RULE: Do NOT slim the face. Do NOT sharpen the jawline. Do NOT "beautify", idealize, or normalize the facial structure.`;

// ─── Style Risk Guards ───────────────────────────────────────────────────────
const MEDIUM_RISK_IDENTITY_GUARD = `IDENTITY PRESERVATION CHECK: Ensure the style does not cause skin over-smoothing. Retain raw, authentic facial geometry and natural pore texture.`;

const HIGH_RISK_IDENTITY_GUARD = `BIOMETRIC OVERRIDE: The dramatic lighting/style MUST NOT cause cheek hollowing, jaw sharpening, or bone structure exaggeration. The face shape must remain EXACTLY as round or wide as the reference. Style is subordinate to identity.`;

const BASE_IDENTITY_PROMPT = `
CRITICAL IDENTITY & TEXTURE REQUIREMENTS:
- BIOMETRICS: Preserve exact facial geometry, natural asymmetry, face width, and natural fullness. NO face slimming. NO model-like bone structure interpolation.
- SKIN TEXTURE: Soft natural cinematic texture. Healthy real skin without hyper-detail noise.
- EYES & EXPRESSION: Natural resting expression. Exact eye shape and iris detail. NO generic AI stare.
- PROHIBITED ACTIONS: NO face replacement, NO artificial rejuvenation, NO digital airbrushing.

ANTI-BEAUTIFICATION OVERRIDE: Do NOT apply cosmetic normalization, generic model archetype blending, or beauty filters to the face. Preserve the exact unique eye shape, nose shape, and facial proportions of the specific individual. The output must NOT look like a generic attractive AI model.
`;

const QUALITY_CONSTRAINTS = `
STRICT AVOIDANCE (CRITICAL):
- NO plastic skin, waxiness, or CGI rendering effects.
- NO aesthetic normalization (do NOT make the person look like a generic model/actor).
- NO jawline sharpening, face narrowing, or altered nose geometry.
- NO over-exposed or blown-out highlights that destroy skin texture.
- NO exaggerated shadows that artificially age or alter bone structure.

NATURAL SKIN BALANCE (REQUIRED):
- Soft natural cinematic lighting, healthy real skin.
- Realistic but flattering skin texture — healthy, not hyper-detailed.
- Preserve natural skin character without emphasizing imperfections.
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
Create a high-end, realistic photoshoot.
WARDROBE TRANSFORMATION IS MANDATORY: Completely change the subject's clothing to match the specific style instructions below.
The face MUST remain the exact biometric match of the input person with RAW skin texture. Style transformation applies ONLY to clothing, lighting, background, and pose.
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

  // Quality constraints for POSITIVE prompt only (negativePrompt goes to finalNegativePrompt)
  const dynamicQualityConstraints = QUALITY_CONSTRAINTS.trim() + "\n" +
    (mode === "free" ? "- NO passport-photo flatness for preview mode.\n" : "");

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

  const finalNegativePrompt = "ugly, deformed, poorly drawn, bad anatomy, bad lighting, low resolution, blurry, watermark, text, amateur photography, heavy skin grain, exaggerated pores, deep facial lines, acne scars, hyper-realistic wrinkles, generic AI face, Instagram face, plastic surgery look, changed facial structure, altered eye shape, altered nose shape, generic model archetype, " + styleConfig.negativePrompt;

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
