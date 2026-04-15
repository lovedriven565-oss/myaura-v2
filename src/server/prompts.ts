export type PromptType = "free" | "premium";
export type StyleId = "business" | "lifestyle" | "aura" | "cinematic" | "luxury" | "editorial";
export type AgeTier = "young" | "mature" | "distinguished";
export type Gender = "male" | "female" | "unset";

export interface DebugPromptParts {
  version: string;
  styleId: StyleId;
  mode: PromptType;
  gender: Gender;
  ageTier: AgeTier;
  index: number;
}

// ─── V8.1: Identity-First Architecture (Multi-Reference Ready) ───────────────

const V8_STYLE_BLOCKS: Record<StyleId, { conservative: string; premium: string }> = {
  business: {
    conservative: "professional business attire, clean office background",
    premium: "dressed in a sharp tailored suit or elegant corporate wear, crisp white shirt. High-end modern corporate environment, soft diffused window light, professional and confident atmosphere, 85mm portrait photography."
  },
  lifestyle: {
    conservative: "casual elegant clothing, outdoor natural background",
    premium: "wearing neutral cashmere knitwear or tailored casuals. Golden hour outdoor lighting, beautifully blurred natural background, relaxed and approachable mood, candid professional photography."
  },
  cinematic: {
    conservative: "cinematic lighting, dramatic mood, dark clothing",
    premium: "wearing dark structured clothing. Low-key dramatic studio lighting, cinematic teal and orange color grading, practical background lights, moody and intense 35mm film aesthetic."
  },
  editorial: {
    conservative: "high fashion editorial style, clean studio background",
    premium: "avant-garde or striking fashion silhouette. Clean minimal studio backdrop, sharp overhead beauty lighting, high-contrast magazine editorial aesthetic, high-fidelity textures."
  },
  luxury: {
    conservative: "luxurious clothing, elegant wealthy background",
    premium: "wearing bespoke silk or fine wool layering. Grand upscale interior setting with warm ambient reading lamps, rich muted color palette, understated wealth and sophistication, soft cinematic bokeh."
  },
  aura: {
    conservative: "ethereal lighting, glowing abstract background",
    premium: "flowing elegant fabrics. Abstract background with soft volumetric light rays and iridescent glowing colors, dreamlike ethereal radiance, fine art dream-pop photography."
  }
};

const VARIETY_FRAMINGS = [
  "Perfectly centered frontal portrait",
  "Subtle 3/4 angle portrait",
  "Medium close-up portrait",
  "Head and shoulders portrait",
  "Environmental portrait with background depth",
  "Relaxed posture portrait"
];

const V8_NEGATIVE_PROMPT = "different person, altered facial features, changed eye color, plastic skin, over-retouched, cgi, 3d render, illustration, distorted anatomy, unnatural eyes";

const IDENTITY_CORE = "A photorealistic portrait of the same person shown in the reference photos. CRITICAL: Maintain strict physical likeness to the references. Preserve the exact facial structure, eye shape, natural eye color, nose, jawline, skin tone, and overall recognizability. Do not alter, beautify, idealize, or reinterpret the subject's identity. Preserve apparent age and gender presentation from the references.";

function buildV8Prompt(gender: Gender, styleId: StyleId, ageTier: AgeTier, mode: PromptType, index: number): string {
  const styleBlock = V8_STYLE_BLOCKS[styleId] || V8_STYLE_BLOCKS.business;
  const framing = VARIETY_FRAMINGS[index % VARIETY_FRAMINGS.length];
  
  let prompt = `${IDENTITY_CORE} Framing: ${framing}. `;

  if (mode === "premium") {
    // V8 Premium (Gemini 3 Pro)
    prompt += `${styleBlock.premium} Extremely high-quality commercial photography, natural skin texture with visible pores, lifelike cinematic lighting, perfect anatomical consistency.`;
  } else {
    // V8 Conservative (Gemini 3.1 Flash / Free)
    prompt += `${styleBlock.conservative}. Highly realistic, natural lighting, clear focus.`;
  }

  return prompt;
}

export function buildPromptProfile(
  styleId: StyleId,
  mode: PromptType,
  index: number = 0,
  ageTier: AgeTier = "young",
  gender: Gender = "unset"
): { positivePrompt: string; negativePrompt: string; debugPromptParts: DebugPromptParts } {
  const positivePrompt = buildV8Prompt(gender, styleId, ageTier, mode, index);
  const negativePrompt = V8_NEGATIVE_PROMPT;

  const debugPromptParts: DebugPromptParts = {
    version: "V8.1-IdentityFirst",
    styleId, mode, gender, ageTier, index
  };

  console.log(`[PROMPT V8.1] style=${styleId} mode=${mode} gender=${gender} idx=${index}`);
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
