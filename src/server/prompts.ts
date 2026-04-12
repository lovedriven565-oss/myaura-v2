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
  business:  { lens: "85mm portrait equivalent, shallow depth of field", lighting: "Dual soft-box frontal fill, even face illumination, zero hard shadows", color_grade: "Natural skin tones, slight warmth, clean neutral highlights" },
  lifestyle: { lens: "50mm, moderate depth of field", lighting: "Warm backlight with soft reflector fill on face, golden-hour quality", color_grade: "Warm amber tones, natural saturation, gentle highlight roll-off" },
  cinematic: { lens: "35mm, slight compression, crisp foreground", lighting: "45° directional key light, soft opposite fill, practical background bokeh", color_grade: "Teal-shifted shadows, orange midtones on skin, deep detailed blacks" },
  editorial: { lens: "Medium format equivalent — compression and micro-detail latitude", lighting: "Overhead butterfly from beauty dish, defined cheekbone shadow line", color_grade: "High-fidelity skin reproduction, luminous whites, clean contrast" },
  luxury:    { lens: "Portrait telephoto 90mm, very shallow depth", lighting: "Wrapped soft-box with warm practical ambient from interior lamps", color_grade: "Rich warm shadows with texture retention, classic film quality" },
  aura:      { lens: "50mm, sharp center focus with heavy background bokeh", lighting: "Multi-source volumetric ambient with pastel-colored fill, face center-exposed", color_grade: "Iridescent highlight bloom on edges, face at accurate neutral exposure" }
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

// ─── V6: Core JSON prompt builder ───────────────────────────────────────────
function buildJsonPrompt(gender: Gender, styleId: StyleId, ageTier: AgeTier, mode: PromptType, index: number): string {
  const scene = SCENE_COMPOSITIONS[styleId] || SCENE_COMPOSITIONS.business;
  const physics = PHOTOGRAPHY_PHYSICS[styleId] || PHOTOGRAPHY_PHYSICS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];

  const genderLabel = gender === "unset" ? "person" : gender;

  const payload = {
    system_directive: {
      mode: "styled_portrait_base",
      instruction:
        "Generate a highly photorealistic styled portrait. " +
        "The reference image provides clothing and pose context only. " +
        "Generate a naturally attractive synthetic face of the specified gender and age — do not attempt identity matching."
    },
    subject: {
      description: `Attractive ${genderLabel}, age tier: ${ageTier}. Natural look, photorealistic skin, clear engaging eyes, confident relaxed expression.`,
      face_generation: "Synthesize a natural attractive face independently — perfect symmetry, clean skin, vivid eyes.",
      clothing_and_pose: mode === "premium"
        ? "Full wardrobe from scene specification below. Ignore reference clothing."
        : "Preserve general clothing character from reference image."
    },
    scene: { wardrobe: scene.wardrobe, setting: scene.setting, mood: scene.mood, framing },
    photography: { lens: physics.lens, lighting: physics.lighting, color_grade: physics.color_grade }
  };

  return JSON.stringify(payload, null, 2);
}

export function buildPromptProfile(
  styleId: StyleId,
  mode: PromptType,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset"
): { positivePrompt: string; negativePrompt: string; debugPromptParts: any } {
  const positivePrompt = buildJsonPrompt(gender, styleId, ageTier, mode, index);
  // Minimal negative prompt — long lists pollute the attention softmax and dilute identity lock
  const negativePrompt = "mutated, deformed, facial reconstruction, different person";

  const debugPromptParts = {
    version: "V6-JSON",
    styleId, mode, gender, ageTier, index,
    framing: VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length],
    scene: SCENE_COMPOSITIONS[styleId],
    physics: PHOTOGRAPHY_PHYSICS[styleId]
  };

  console.log(`[PROMPT V6-JSON] style=${styleId} mode=${mode} gender=${gender} ageTier=${ageTier} idx=${index}`);
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
