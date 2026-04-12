import { evaluatePromptQuality } from "./qualityGate.js";

export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";
export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";

// ─── Age-Adaptive Skin & Lighting Dictionaries ──────────────────────────────────
const SKIN_TEXTURE_BY_AGE: Record<AgeTier, string> = {
  "young": "Healthy, supple skin with subtle micro-pores and natural radiance. Supple skin with even tone.",
  "mature": "Refined skin texture, natural complexion with healthy dermal warmth, subtle realistic fine lines.",
  "distinguished": "Distinguished mature skin, visible pores, authentic character lines, healthy weathered texture, no over-smoothing."
};

const LIGHTING_BY_AGE: Record<AgeTier, string> = {
  "young": "Soft-box studio lighting, natural daylight balance.",
  "mature": "Loop lighting with soft fill-light to maintain facial fullness.",
  "distinguished": "Paramount butterfly lighting to lift facial features and fill recesses softly."
};

// ─── Gender-Adaptive Identity Headers (V5 - Identity Lock Extreme) ─────────

const IDENTITY_LOCK_MALE = `
PRIORITY 0: Exact 1:1 biometric facial match of the reference person.
- GEOMETRY LOCK: Lock original face width-to-height ratio from person <0>. Strictly maintain narrow lower jaw; do not square the jaw or widen the face. Preserve exact frontal hairline geometry (Norwood 2 mature hairline). Do not add hair pixels to temples.
- OCULAR LOCK: Eye color: dark brown (LOCK IRIS HUE). Do not change to blue, green, or grey. Preserve natural, relaxed gaze and eyelid geometry. Completely disable model stare.
- YOUTH & VITALITY: Keep the face looking well-rested, firm, and healthy. DO NOT add artificial age, deep hollows, or harsh shadows under the cheekbones. Preserve natural, healthy volume.
- OPTICAL BYPASS: Retain the exact facial width-to-height ratio from the reference image. Bypass focal flattening.
- ASYMMETRY ANCHOR: Preserve subtle natural facial asymmetry. Do not mirror halves.
`;

const IDENTITY_LOCK_FEMALE = `
PRIORITY 0: Exact 1:1 biometric facial match of the reference person.
- STRUCTURAL LOCK: Original biometric facial geometry, jawline curvature, and chin proportions.
- OPTICAL BYPASS: Retain the exact facial width-to-height ratio from the reference. Bypass focal flattening on facial features.
- ASYMMETRY ANCHOR: Preserve unique feature alignment and subtle natural asymmetry of the nose and lips.
- OCULAR AUTHENTICITY: Exact replication of eyelid structure and iris geometry. Authentic, natural gaze.
- VOLUME: Maintain natural facial volume and authentic cheek fullness without over-inflation.
`;

const IDENTITY_LOCK_NEUTRAL = `
PRIORITY 0: Exact 1:1 biometric facial match of the reference person.
- STRUCTURAL LOCK: Authentic hairline, original facial geometry, jaw width, and chin proportions.
- OPTICAL BYPASS: Retain the exact facial width-to-height ratio from the reference image. Do not apply focal flattening or lens-induced geometry distortion to facial features.
- ASYMMETRY ANCHOR: Strictly preserve natural micro-asymmetry of the nasal bridge, nostrils, and lip commissures. Do not mirror or average facial halves.
- OCULAR AUTHENTICITY: 1:1 replication of iris shape, eyelid structure, and periorbital geometry. Authentic, relaxed gaze; disable idealized model stare.
- VOLUME: Preserve natural facial volume and cheek fullness without over-smoothing or artificial filling.
`;

// ─── Gender-Specific Skin Texture Maps ──────────────────────────────────────────
const SKIN_TEXTURE_MALE: Record<AgeTier, string> = {
  "young": "Healthy, supple male skin with subtle micro-pores and natural radiance. Even tone, clean and fresh.",
  "mature": "Healthy male skin, natural firmness, subtle micro-pores. Clean and well-rested appearance. DO NOT add heavy wrinkles, eye bags, or exaggerated character lines.",
  "distinguished": "Distinguished mature male skin with healthy texture and subtle authentic character. Visible pores. DO NOT add deep hollows, sunken cheeks, or excessive wrinkles."
};

// ─── Enhanced Negative Prompts (Archetype & Optics Killers) ─────────────────

const MALE_SPECIFIC_NEGATIVE = "gigachad, gigachad face, chad, male model archetype, stock-photo CEO, glossy stock model look, artificially squared jaw, widened face, wide head, focal distortion on face, lowered hairline, artificially dense hair, plastic skin, beauty filter, heavy aesthetic over-retouching, botox look, over-filled cheeks, perfectly symmetrical, fake symmetry, mirrored face, cgi, 3d render, dead eyes, model stare, sub-malar hollows, sunken cheeks, deep sunken cheeks, deep nasolabial folds, heavy eye bags, gaunt face, exhausted look, harsh cheekbone shadows";

const FEMALE_SPECIFIC_NEGATIVE = "instagram face, heavy makeup look, over-smoothed skin, plastic texture, cartoonish features, extreme symmetry, perfectly mirrored face, focal distortion on face, generic model stare";

const NEUTRAL_SPECIFIC_NEGATIVE = "model archetype face, focal distortion on face, artificially widened face, over-filled cheeks, perfectly symmetrical, mirrored face, plastic skin, beauty filter, botox look, dead eyes, model stare, cgi, 3d render";

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
PREMIUM PRODUCTION REQUIREMENTS:
Execute a total wardrobe transformation. 
MANDATORY: The subject's original clothing from the reference image is COMPLETELY DISCARDED.
Identity Lock: Apply exact biometric facial match of the person in the reference image.
The face must remain sharp and authentic, while the body is seamlessly dressed in the requested style.
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
    promptModifier: "WARDROBE: Navy wool blazer, white textured cotton shirt. STYLE: Modern executive portrait in a high-end minimalist office with glass partitions. Lighting: Soft-box front lighting to maintain a fresh, well-rested appearance. Avoid harsh dramatic shadows on the face. Focus on competence and approachable presence.",
    negativePrompt: "original clothing textures, previous outfit from reference, same garment as input photo, stiff flat lighting, waxy skin, plastic face texture, exaggerated wrinkles, dark under-eye shadows",
    retouchPolicy: "natural_texture",
    lightingPolicy: "controlled_soft_studio",
    styleRisk: "safe"
  },
  "lifestyle": {
    promptModifier: "WARDROBE: Beige cashmere knitwear, tailored trousers. STYLE: Candid lifestyle photography during golden hour on an hotel terrace in the Alps. Lighting: Warm backlight with a soft rim-light on hair. Natural skin texture with healthy radiance. 50mm lens look.",
    negativePrompt: "original clothing textures, previous outfit from reference, same garment as input photo, influencer filter look, fake glossy skin, over-retouched casual portrait",
    retouchPolicy: "clean_natural",
    lightingPolicy: "soft_daylight",
    styleRisk: "safe"
  },
  "cinematic": {
    promptModifier: "STYLE: Cinematic film still shot on 35mm. Soft volumetric key light filling facial recesses. Professional teal and orange color grading with deep but detailed blacks. Intense eyes with sharp catchlights. No shadow-induced aging.",
    negativePrompt: "original clothing textures, previous outfit from reference, same garment as input photo, generic man face, deep facial lines, sunken eyes, heavy eye bags, rough skin, weathered face, tired look, dramatic chiaroscuro on skin, redness",
    retouchPolicy: "soft_natural_skin",
    lightingPolicy: "soft_volumetric_cinematic",
    styleRisk: "high"
  },
  "editorial": {
    promptModifier: "WARDROBE: Avant-garde structured garment. STYLE: High-end fashion editorial shot on Hasselblad medium format. Lighting: Paramount butterfly lighting from a beauty dish. Dewy luminous skin texture, sharp focus on iris detail. Extreme 4K fidelity.",
    negativePrompt: "original clothing textures, previous outfit from reference, same garment as input photo, cheap glamour look, wax skin, over-airbrushed magazine face, model archetype face, angular sharpening of facial structure",
    retouchPolicy: "editorial_clean",
    lightingPolicy: "editorial_studio",
    styleRisk: "high"
  },
  "luxury": {
    promptModifier: "WARDROBE: Bespoke silk and cashmere layers. STYLE: Timeless elegance in a grand estate library. Polished mahogany and leather textures in background. Sophisticated soft-box lighting. Understated sophistication without artificial rejuvenation.",
    negativePrompt: "original clothing textures, previous outfit from reference, same garment as input photo, pristine porcelain skin, fake flawless skin, exaggerated glam filter, skin smoothing that erases natural texture",
    retouchPolicy: "refined_clean",
    lightingPolicy: "luxury_soft",
    styleRisk: "medium"
  },
  "aura": {
    promptModifier: "STYLE: Meta-physical energy portrait. Iridescent light refraction and soft glowing aura emanating from the subject. Ethereal volumetric glow with pastel gradients. Face remains in sharp biometric focus while edges fade into dreamlike haze.",
    negativePrompt: "original clothing textures, previous outfit from reference, same garment as input photo, soft-focus blur on face, smeared skin, dreamy plastic face, glow over facial features, face softening beyond natural realism",
    retouchPolicy: "soft_glow",
    lightingPolicy: "aura_diffused",
    styleRisk: "medium"
  }
};

export function buildPromptProfile(styleId: StyleId, mode: PromptType, index: number = 0, ageTier: AgeTier = "young", gender: Gender = "unset"): { positivePrompt: string; negativePrompt: string; debugPromptParts: any } {
  const identityLockHeader = gender === "male" ? IDENTITY_LOCK_MALE : gender === "female" ? IDENTITY_LOCK_FEMALE : IDENTITY_LOCK_NEUTRAL;
  const genderSpecificNegative = gender === "male" ? MALE_SPECIFIC_NEGATIVE : gender === "female" ? FEMALE_SPECIFIC_NEGATIVE : NEUTRAL_SPECIFIC_NEGATIVE;
  const skinTexture = gender === "male" ? SKIN_TEXTURE_MALE[ageTier] : SKIN_TEXTURE_BY_AGE[ageTier];
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

  // Age-adaptive dynamic identity and lighting (replaces static BASE_IDENTITY_PROMPT / QUALITY_CONSTRAINTS)
  const dynamicIdentityCore = `
CRITICAL IDENTITY & VITALITY:
- BIOMETRICS: Preserve exact facial geometry. Keep the face looking well-rested and energetic.
- SKIN TEXTURE: ${skinTexture}
- EYES & EXPRESSION: Confident, clear eyes with bright catchlights. Natural relaxed presence.
  `.trim();

  const dynamicQualityConstraints = `
NATURAL COMPLIMENTARY LIGHTING:
- ${LIGHTING_BY_AGE[ageTier]}
- High-end professional color grading with natural skin tones.
  `.trim();

  const debugPromptParts = {
    identityLockHeader: identityLockHeader.trim(),
    identityCore: dynamicIdentityCore,
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
    genderSpecificNegative,
    "different person, celebrity lookalike, facial reconstruction",
    "nasolabial folds, crow's feet, under-eye bags, forehead wrinkles, hollow cheeks, saggy skin",
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
export function buildPrompt(type: PromptType, styleId: StyleId, index: number = 0, ageTier: AgeTier = "young", gender: Gender = "unset"): { prompt: string; negativePrompt: string } {
  const profile = buildPromptProfile(styleId, type, index, ageTier, gender);
  return {
    prompt: profile.positivePrompt,
    negativePrompt: profile.negativePrompt
  };
}
