export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";
export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";

// ─── V6: Scene Compositions (trigger-word free) ─────────────────────────────
const SCENE_COMPOSITIONS: Record<StyleId, { wardrobe: string; setting: string; mood: string }> = {
  business:  { wardrobe: "Navy wool blazer, white structured cotton shirt", setting: "Contemporary office interior, glass partitions, diffused window light in background", mood: "Composed, approachable, professional" },
  lifestyle: { wardrobe: "Beige cashmere knitwear, tailored neutral trousers", setting: "Outdoor mountain terrace, golden-hour warm ambient light", mood: "Relaxed, candid, natural confidence" },
  cinematic: { wardrobe: "Dark structured jacket or premium fabric top", setting: "Minimal studio or urban interior, atmospheric practical lights in background", mood: "Controlled emotion, directional lighting drama" },
  editorial: { wardrobe: "Avant-garde structured garment with strong silhouette", setting: "Clean studio backdrop, minimal props, sharp foreground focus", mood: "High-fashion precision, luminous detail" },
  luxury:    { wardrobe: "Bespoke silk and cashmere layering, muted heritage palette", setting: "Grand estate interior — mahogany shelves, leather furniture, warm reading lamps", mood: "Understated sophistication, timeless composure" },
  aura:      { wardrobe: "Flowing fabric with iridescent sheen", setting: "Abstract backdrop with volumetric light refraction and soft pastel gradients", mood: "Ethereal radiance — face sharp, background edges dissolve into light" }
};

// ─── V6: Photography Physics (technical only, no semantic labels) ─────────────
const PHOTOGRAPHY_PHYSICS: Record<StyleId, { lens: string; lighting: string; color_grade: string }> = {
  business:  { lens: "85mm portrait equivalent, f/1.8 shallow depth of field, creamy background bokeh", lighting: "Dual soft-box frontal fill, even face illumination, zero hard shadows", color_grade: "Natural skin tones, slight warmth, clean neutral highlights, subtle film grain" },
  lifestyle: { lens: "50mm, f/2.0 moderate depth of field, natural background separation", lighting: "Warm backlight with soft reflector fill on face, golden-hour quality", color_grade: "Warm amber tones, natural saturation, gentle highlight roll-off, organic film grain" },
  cinematic: { lens: "35mm, f/1.4 crisp foreground with deep background bokeh", lighting: "45° directional key light, soft opposite fill, practical background bokeh", color_grade: "Teal-shifted shadows, orange midtones on skin, deep detailed blacks, cinematic film grain" },
  editorial: { lens: "Medium format equivalent, f/2.8 — compression, micro-detail latitude, razor-sharp focus plane", lighting: "Overhead butterfly from beauty dish, defined cheekbone shadow line", color_grade: "High-fidelity skin reproduction, luminous whites, clean contrast, fine-grain texture" },
  luxury:    { lens: "Portrait telephoto 90mm, f/1.6 very shallow depth, lush background bokeh", lighting: "Wrapped soft-box with warm practical ambient from interior lamps", color_grade: "Rich warm shadows with texture retention, classic analogue film grain" },
  aura:      { lens: "50mm, f/1.2 sharp center focus, extreme background bokeh and light diffusion", lighting: "Multi-source volumetric ambient with pastel-colored fill, face center-exposed", color_grade: "Iridescent highlight bloom on edges, face at accurate neutral exposure, dreamlike film grain" }
};

// ─── V6: Variety framings for multi-image premium batches ────────────────────
const VARIETY_FRAMINGS = [
  "Straight-on frontal framing, face perfectly centered",
  "Slight 3/4 turn left, natural shoulder angle",
  "Medium shot including upper chest, composed stance",
  "Tighter facial crop from mid-chest up",
  "Slightly wider environmental framing with background context",
  "Slight 3/4 turn right, relaxed natural posture"
];

// ─── V6: Core Natural Language prompt builder ─────────────────────────────
function buildNaturalLanguagePrompt(gender: Gender, styleId: StyleId, ageTier: AgeTier, mode: PromptType, index: number): string {
  const scene = SCENE_COMPOSITIONS[styleId] || SCENE_COMPOSITIONS.business;
  const physics = PHOTOGRAPHY_PHYSICS[styleId] || PHOTOGRAPHY_PHYSICS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  const genderLabel = gender === "unset" ? "person" : gender;

  let prompt = "";

  // 1. CRITICAL CONSTRAINT (Weight: Maximum)
  if (gender !== "unset") {
    prompt += `[CRITICAL REQUIREMENT: THIS PORTRAIT DEPICTS A ${gender.toUpperCase()}. All anatomical and visual features MUST strictly match a ${gender}. Do not generate a ${gender === "female" ? "male" : "female"}.] `;
  }

  // 2. BASE DIRECTIVE
  prompt += "Generate an ultra-high resolution, photorealistic styled portrait, indistinguishable from a professional photograph. ";

  // 3. SUBJECT
  prompt += `Subject: Attractive ${genderLabel}, age tier: ${ageTier}. Natural look, highly detailed photorealistic skin, clear engaging eyes, confident relaxed expression. `;
  if (mode === "premium") {
    prompt += `Ignore reference clothing. `;
  } else {
    prompt += `Preserve general clothing character from reference image, styled for ${genderLabel}. `;
  }

  // 4. SCENE & WARDROBE
  prompt += `Wardrobe: ${scene.wardrobe}. Setting: ${scene.setting}. Mood: ${scene.mood}. `;

  // 5. PHOTOGRAPHY PHYSICS
  prompt += `Camera and Lighting: ${physics.lens}. ${physics.lighting}. ${physics.color_grade}. `;
  
  // 6. FRAMING
  prompt += `Framing: ${framing}.`;

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
  // Minimal negative prompt — long lists pollute the attention softmax and dilute identity lock
  const negativePrompt = "mutated, deformed, facial reconstruction, different person";

  const debugPromptParts = {
    version: "V6-NL",
    styleId, mode, gender, ageTier, index,
    framing: VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length],
    scene: SCENE_COMPOSITIONS[styleId],
    physics: PHOTOGRAPHY_PHYSICS[styleId]
  };

  console.log(`[PROMPT V6-NL] style=${styleId} mode=${mode} gender=${gender} ageTier=${ageTier} idx=${index}`);
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
