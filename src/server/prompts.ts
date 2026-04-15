export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";
export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";

// ─── V7.0: Architectural Overhaul - Optical & Slavic Optimizations ───────────────
const SCENE_COMPOSITIONS: Record<StyleId, { wardrobe: string; setting: string; mood: string }> = {
  business:  { wardrobe: "Navy wool blazer, white structured cotton shirt", setting: "Contemporary office interior, glass partitions, diffused window light in background", mood: "Composed, professional" },
  lifestyle: { wardrobe: "Beige cashmere knitwear, tailored neutral trousers", setting: "Outdoor mountain terrace, golden-hour ambient light", mood: "Relaxed, natural confidence" },
  cinematic: { wardrobe: "Dark structured jacket or premium fabric top", setting: "Minimal studio or urban interior, practical lights", mood: "Controlled emotion, drama" },
  editorial: { wardrobe: "Avant-garde structured garment with strong silhouette", setting: "Clean studio backdrop, sharp foreground focus", mood: "High-fashion precision" },
  luxury:    { wardrobe: "Bespoke silk and cashmere layering, muted palette", setting: "Grand estate interior, warm reading lamps", mood: "Understated sophistication" },
  aura:      { wardrobe: "Flowing fabric with iridescent sheen", setting: "Abstract backdrop with volumetric light refraction", mood: "Ethereal radiance" }
};

// V7.0: Strict Sony A7IV / Optical Physics emulation
const PHOTOGRAPHY_PHYSICS: Record<StyleId, { lens: string; lighting: string; color_grade: string }> = {
  business:  { lens: "Sony A7IV, 85mm f/1.4 GM lens, shallow depth of field", lighting: "Dual soft-box frontal fill, zero hard shadows", color_grade: "S-Cinetone profile, natural skin tones, 35mm organic film grain" },
  lifestyle: { lens: "Sony A7IV, 50mm f/1.2 GM lens", lighting: "Warm backlight with soft reflector fill on face", color_grade: "S-Log3 converted to Rec.709, warm amber tones, 35mm organic film grain" },
  cinematic: { lens: "Sony A7IV, 35mm f/1.4 GM lens", lighting: "45° directional key light, soft opposite fill", color_grade: "Teal-and-orange shifted shadows, cinematic 35mm film grain" },
  editorial: { lens: "Medium format equivalent, f/2.8 sharp focus plane", lighting: "Overhead butterfly from beauty dish", color_grade: "High-fidelity skin reproduction, clean contrast, fine-grain texture" },
  luxury:    { lens: "Sony A7IV, 85mm f/1.4 GM lens, lush bokeh", lighting: "Wrapped soft-box with warm practical ambient", color_grade: "Rich warm shadows, classic analogue film grain" },
  aura:      { lens: "Sony A7IV, 50mm f/1.2 GM lens, extreme diffusion", lighting: "Multi-source volumetric ambient", color_grade: "Iridescent highlight bloom, dreamlike film grain" }
};

const VARIETY_FRAMINGS = [
  "Frontal portrait, face perfectly centered",
  "Slight 3/4 turn left, natural shoulder angle",
  "Medium shot including upper chest",
  "Tighter facial crop",
  "Environmental framing with background context",
  "Slight 3/4 turn right, relaxed posture"
];

// V7.0: Regional Anthropometry — Slavic/Eastern European markers
const SLAVIC_MORPHOTYPE = "soft heart-shaped face, light Slavic eyes (blue/grey/green), fair skin with rosy undertones, straight soft nose profile";

function buildNaturalLanguagePrompt(gender: Gender, styleId: StyleId, ageTier: AgeTier, mode: PromptType, index: number): string {
  const scene = SCENE_COMPOSITIONS[styleId] || SCENE_COMPOSITIONS.business;
  const physics = PHOTOGRAPHY_PHYSICS[styleId] || PHOTOGRAPHY_PHYSICS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const genderLabel = gender === "unset" ? "person" : gender;

  let prompt = "";

  if (gender !== "unset") {
    prompt += `[REQUIREMENT: EXACTLY MATCH ${gender.toUpperCase()} GENDER.] `;
  }

  // 1. Core Directives & Likeness (Token Optimized)
  if (mode === "premium") {
    prompt += `Subject: Person from reference image. Identity anchor: EXACT facial structure, eye spacing, lip shape, jawline, and skin tone. Maintain absolute strict physical likeness to the reference. Preserve the exact original eye color, facial structure, and skin tone. Do not alter the subject's fundamental ethnic or physical traits. Apply the high-end studio lighting and style ONLY to the environment and the subject's overall polish, but never at the cost of changing their native facial identity. Real ${genderLabel}, ${ageTier} age tier. Anthropometric traits: ${SLAVIC_MORPHOTYPE}. `;
  } else {
    prompt += `Subject: Real ${genderLabel}, ${ageTier} age tier. Anthropometric traits: ${SLAVIC_MORPHOTYPE}. Preserve reference face structure, original eye color, and native facial identity. `;
  }

  // 2. Optical & Scene Physics (Sony A7IV)
  prompt += `Shot with ${physics.lens}. Wardrobe: ${scene.wardrobe}. Setting: ${scene.setting}. Lighting: ${physics.lighting}. Color grading: ${physics.color_grade}. `;
  
  // 3. Anchors & Framing
  prompt += `Framing: ${framing}. Stability anchors: symmetrical pupils, anatomical knuckle definition, realistic skin-to-hair transition. No plastic beauty filters.`;

  return prompt;
}

export function buildPromptProfile(
  styleId: StyleId,
  mode: PromptType,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset"
): { positivePrompt: string; negativePrompt: string; debugPromptParts: any } {
  const positivePrompt = buildNaturalLanguagePrompt(gender, styleId, ageTier, mode, index);
  // Negative prompt minimized to prevent attention softmax dilution
  const negativePrompt = "mutated, deformed, facial reconstruction, different person";

  const debugPromptParts = {
    version: "V7.0-Architect",
    styleId, mode, gender, ageTier, index
  };

  console.log(`[PROMPT V7.0] style=${styleId} mode=${mode} gender=${gender} idx=${index}`);
  return { positivePrompt, negativePrompt, debugPromptParts };
}

export function buildPrompt(
  type: PromptType,
  styleId: StyleId,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset"
): { prompt: string; negativePrompt: string } {
  const { positivePrompt, negativePrompt } = buildPromptProfile(styleId, type, index, ageTier, gender);
  return { prompt: positivePrompt, negativePrompt };
}
