import { evaluatePromptQuality } from "./qualityGate.js";

export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";

// ─── Identity Lock Header ────────────────────────────────────────────────────
const IDENTITY_LOCK_HEADER = `
PRIORITY 0: Exact 1:1 photorealistic match of the person in the provided reference image.
Maintain exact facial volume, youthful eye-area structure, and natural cheek fullness.
NO facial hollowing, NO added wrinkles, NO deepening of nasolabial folds.`;

const BASE_IDENTITY_PROMPT = ` 
CRITICAL IDENTITY & VITALITY:
- BIOMETRICS: Preserve exact facial geometry. Keep the face looking well-rested and energetic.
- SKIN TEXTURE: Healthy, supple skin with subtle micro-pores. Natural healthy skin radiance. Supple skin with even tone.
- EYES & EXPRESSION: Confident, clear eyes with bright catchlights. Natural relaxed presence.
- AVOID: No dark circles, no tired eyes, no skin redness, no exaggerated texture.
`;

const QUALITY_CONSTRAINTS = `
NATURAL COMPLIMENTARY LIGHTING:
- Use soft-box studio lighting to wrap around features.
- Fill shadows to maintain smooth facial transitions and avoid aging.
- High-end professional color grading with natural skin tones.
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
    promptModifier: "WARDROBE: Navy wool blazer, white textured cotton shirt. STYLE: Modern executive portrait in a high-end minimalist office with glass partitions. Lighting: Loop lighting with soft fill-light to maintain facial fullness. Focus on competence and approachable presence.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO cold corporate passport look, NO overly stiff or gray lifeless face, NO age exaggeration from seriousness.",
    retouchPolicy: "natural_texture",
    lightingPolicy: "controlled_soft_studio",
    styleRisk: "safe"
  },
  "lifestyle": {
    promptModifier: "WARDROBE: Beige cashmere knitwear, tailored trousers. STYLE: Candid lifestyle photography during golden hour on an hotel terrace in the Alps. Lighting: Warm backlight with a soft rim-light on hair. Natural skin texture with healthy radiance. 50mm lens look.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO influencer filter look, NO fake glossy skin, NO over-retouched casual portrait.",
    retouchPolicy: "clean_natural",
    lightingPolicy: "soft_daylight",
    styleRisk: "safe"
  },
  "cinematic": {
    promptModifier: "STYLE: Cinematic film still shot on 35mm. Soft volumetric key light filling facial recesses. Professional teal and orange color grading with deep but detailed blacks. Intense eyes with sharp catchlights. No shadow-induced aging.",
    negativePrompt: "different person, generic man face, deep facial lines, sunken eyes, heavy eye bags, rough skin, weathered face, older version of subject, tired look, dramatic chiaroscuro on skin, redness",
    retouchPolicy: "soft_natural_skin",
    lightingPolicy: "soft_volumetric_cinematic",
    styleRisk: "high"
  },
  "editorial": {
    promptModifier: "WARDROBE: Avant-garde structured garment. STYLE: High-end fashion editorial shot on Hasselblad medium format. Lighting: Paramount butterfly lighting from a beauty dish. Dewy luminous skin texture, sharp focus on iris detail. Extreme 4K fidelity.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO cheap glamour look, NO wax skin, NO over-airbrushed magazine face, NO face reconstruction toward model archetype, NO angular sharpening of facial structure.",
    retouchPolicy: "editorial_clean",
    lightingPolicy: "editorial_studio",
    styleRisk: "high"
  },
  "luxury": {
    promptModifier: "WARDROBE: Bespoke silk and cashmere layers. STYLE: Timeless elegance in a grand estate library. Polished mahogany and leather textures in background. Sophisticated soft-box lighting. Understated sophistication without artificial rejuvenation.",
    negativePrompt: "NO unchanged input clothing in premium mode, NO pristine porcelain skin, NO fake flawless skin, NO exaggerated glam filter, NO skin smoothing that erases natural texture.",
    retouchPolicy: "refined_clean",
    lightingPolicy: "luxury_soft",
    styleRisk: "medium"
  },
  "aura": {
    promptModifier: "STYLE: Meta-physical energy portrait. Iridescent light refraction and soft glowing aura emanating from the subject. Ethereal volumetric glow with pastel gradients. Face remains in sharp biometric focus while edges fade into dreamlike haze.",
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

  // Quality constraints for POSITIVE prompt only (negativePrompt goes to finalNegativePrompt)
  const dynamicQualityConstraints = QUALITY_CONSTRAINTS.trim() + "\n" +
    (mode === "free" ? "Passport-photo flatness acceptable for preview mode.\n" : "");

  const debugPromptParts = {
    identityLockHeader: IDENTITY_LOCK_HEADER.trim(),
    identityCore: BASE_IDENTITY_PROMPT.trim(),
    layerMode: layerPrompt.trim(),
    styleModifier: styleConfig.promptModifier,
    retouchPolicy: styleConfig.retouchPolicy,
    lightingPolicy: styleConfig.lightingPolicy,
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
    debugPromptParts.varietyModifier,
    debugPromptParts.qualityConstraints
  ].filter(Boolean).join("\n\n");

  const finalNegativePrompt = [
    "nasolabial folds, crow's feet, under-eye bags, forehead wrinkles, hollow cheeks, saggy skin",
    "different person, generic male face, archetype face, celebrity lookalike, facial reconstruction",
    "oily skin, red skin, acne scars, hyper-pigmentation, sunburned skin, rough texture, sharp micro-contrast",
    "sadness, exhaustion, anger, tense face, squinting eyes",
    styleConfig.negativePrompt
  ].join(", ");

  const quality = evaluatePromptQuality(finalPrompt, finalNegativePrompt);
  if (quality.likeness < 5 || quality.agePreservation < 5 || quality.skinQuality < 5) {
    console.warn(`[QUALITY GATE WARNING] Style: ${styleId}. Scores: Likeness(${quality.likeness}/10), Age(${quality.agePreservation}/10), Skin(${quality.skinQuality}/10). Warnings: ${quality.warnings.join(' | ')}`);
  } else {
    console.log(`[QUALITY GATE PASS] Style: ${styleId}. Scores: Likeness(${quality.likeness}/10), Age(${quality.agePreservation}/10), Skin(${quality.skinQuality}/10)`);
  }

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
