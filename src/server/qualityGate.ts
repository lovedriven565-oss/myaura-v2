/**
 * Quality Gate Module for Post-Generation Evaluation
 * 
 * Provides both a Vertex AI multimodal judge (when available)
 * and a rule-based fallback evaluator.
 */

export interface QualityScore {
  // 3-Score system (0.00-1.00 scale)
  identityScore: number;       // Face geometry and recognizability
  expressionScore: number;     // Natural expression, anti-fatigue
  noveltyScore: number;        // Visual differentiation from source

  // Legacy compatibility (0-100 scale)
  likenessScore: number;      // 0-100: does the face match references?
  ageDriftScore: number;      // 0-100: 100 = no age change, 0 = severe aging/de-aging
  skinRealismScore: number;   // 0-100: 100 = natural skin, 0 = plastic/wax
  eyeConsistencyScore: number;// 0-100: eye color and detail preserved
  premiumLookScore: number;   // 0-100: overall premium quality feel

  overallPass: boolean;
  overallScore: number;
  rejectReasons: string[];
  rerollMode: "identity" | "expression" | "echo" | null;
}

export interface QualityGateResult {
  score: QualityScore;
  shouldReroll: boolean;
  rerollMode: "identity" | "expression" | "echo" | null;
  evaluationMethod: "multimodal_judge" | "rule_based_fallback";
  evaluationTimeMs: number;
}

// Configurable thresholds with env wrappers
const IDENTITY_THRESHOLD = parseFloat(process.env.QUALITY_IDENTITY_THRESHOLD || "0.86");
const EXPRESSION_THRESHOLD = parseFloat(process.env.QUALITY_EXPRESSION_THRESHOLD || "0.82");
const NOVELTY_THRESHOLD = parseFloat(process.env.QUALITY_NOVELTY_THRESHOLD || "0.45");
const HARD_FAIL_IDENTITY = parseFloat(process.env.QUALITY_HARD_FAIL_IDENTITY || "0.60");
const HARD_FAIL_EXPRESSION = parseFloat(process.env.QUALITY_HARD_FAIL_EXPRESSION || "0.50");
const HARD_FAIL_NOVELTY = parseFloat(process.env.QUALITY_HARD_FAIL_NOVELTY || "0.30");
const MAX_RETRIES = parseInt(process.env.QUALITY_MAX_RETRIES || "0");
const RETRY_MODE_ENABLED = process.env.RETRY_MODE_ENABLED === "true";

// Track reroll counts per generation
const rerollCounts = new Map<string, number>();

/**
 * Attempt multimodal evaluation using Vertex AI / Gemini.
 * Returns null if unavailable or fails — caller should use fallback.
 */
async function multimodalJudge(
  referenceBase64: string,
  generatedBase64: string,
  mimeType: string,
  style: string
): Promise<QualityScore | null> {
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = process.env.USE_VERTEX_AI === "true"
      ? new GoogleGenAI({})
      : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const evaluationPrompt = `You are a professional portrait photography quality judge specializing in identity preservation.
Compare the REFERENCE photo (first image) with the GENERATED photo (second image).
The generated photo should be in "${style}" style.

Rate these aspects from 0-100:
- likeness: Does the generated face match the SPECIFIC REFERENCE PERSON exactly? Penalize heavily if the face has drifted toward a generic attractive/model archetype even if it looks good. (facial structure, features, proportions must match)
- ageDrift: 100 = same age appearance as reference, 0 = significant aging or de-aging caused by style lighting
- skinRealism: 100 = natural realistic skin with visible pores and micro-texture, 0 = plastic/wax/over-smoothed
- eyeConsistency: 100 = same eye shape, color and detail as reference, 0 = wrong color or broken eyes
- premiumLook: 100 = magazine-quality premium result, 0 = amateur/low quality
- expressionScore: 100 = calm, confident, approachable, 0 = sad, tense, tired, stern, or harsh under-eye shadows

Respond ONLY with a JSON object, no markdown, no explanation:
{"likeness":N,"ageDrift":N,"skinRealism":N,"eyeConsistency":N,"premiumLook":N,"expressionScore":N}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-001",
      contents: [
        { inlineData: { data: referenceBase64, mimeType } },
        { inlineData: { data: generatedBase64, mimeType } },
        { text: evaluationPrompt }
      ],
    });

    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const rejectReasons: string[] = [];

    // 3-Score threshold checks
    if (parsed.identityScore < IDENTITY_THRESHOLD) rejectReasons.push("identity_below_threshold");
    if (parsed.identityScore < HARD_FAIL_IDENTITY) rejectReasons.push("HARD_FAIL: different_person_detected");
    if (parsed.expressionScore < EXPRESSION_THRESHOLD) rejectReasons.push("expression_below_threshold");
    if (parsed.expressionScore < HARD_FAIL_EXPRESSION) rejectReasons.push("HARD_FAIL: sad_tired_expression");
    if (parsed.noveltyScore < NOVELTY_THRESHOLD) rejectReasons.push("novelty_below_threshold");
    if (parsed.noveltyScore < HARD_FAIL_NOVELTY) rejectReasons.push("HARD_FAIL: near_duplicate_of_source");

    // Determine rerollMode for targeted retry (when enabled)
    let rerollMode: QualityGateResult["rerollMode"] = null;
    if (parsed.identityScore < HARD_FAIL_IDENTITY) {
      rerollMode = "identity";
    } else if (parsed.expressionScore < HARD_FAIL_EXPRESSION) {
      rerollMode = "expression";
    } else if (parsed.noveltyScore < HARD_FAIL_NOVELTY) {
      rerollMode = "echo";
    }

    const overallScore = Math.round(
      (parsed.likeness * 0.35) +      // identity is the product — highest weight
      (parsed.ageDrift * 0.15) +
      (parsed.skinRealism * 0.15) +
      (parsed.eyeConsistency * 0.10) +
      (parsed.premiumLook * 0.10) +   // style quality is secondary to identity
      (parsed.expressionScore * 0.15)
    );

    return {
      // 3-Score system
      identityScore: parsed.identityScore ?? 0.75,
      expressionScore: parsed.expressionScore ?? 0.75,
      noveltyScore: parsed.noveltyScore ?? 0.60,
      // Legacy fields
      likenessScore: parsed.likeness,
      ageDriftScore: parsed.ageDrift,
      skinRealismScore: parsed.skinRealism,
      eyeConsistencyScore: parsed.eyeConsistency,
      premiumLookScore: parsed.premiumLook,
      overallPass: (parsed.identityScore ?? 0.75) >= IDENTITY_THRESHOLD && (parsed.expressionScore ?? 0.75) >= EXPRESSION_THRESHOLD && (parsed.noveltyScore ?? 0.60) >= NOVELTY_THRESHOLD,
      overallScore,
      rejectReasons,
      rerollMode,
    };
  } catch (err: any) {
    console.warn(`[QualityGate] Multimodal judge failed: ${err.message}`);
    return null;
  }
}

/**
 * Rule-based fallback evaluator.
 * Uses buffer heuristics when multimodal judge is unavailable.
 * This is intentionally generous — it catches only obvious failures.
 */
function ruleBasedFallback(generatedBuffer: Buffer, style: string): QualityScore {
  const rejectReasons: string[] = [];

  // Check if output is too small (likely generation failure)
  const sizeKB = generatedBuffer.length / 1024;
  let premiumLookScore = 70;
  let skinRealismScore = 70;

  if (sizeKB < 20) {
    rejectReasons.push("output_too_small");
    premiumLookScore = 10;
  } else if (sizeKB < 50) {
    rejectReasons.push("output_low_quality");
    premiumLookScore = 30;
  } else if (sizeKB > 200) {
    premiumLookScore = 80; // larger output = more detail = better
  }

  // Entropy check on output
  const sample = generatedBuffer.slice(
    Math.min(2048, generatedBuffer.length),
    Math.min(10240, generatedBuffer.length)
  );
  let entropy = 0;
  if (sample.length > 0) {
    const freq = new Array(256).fill(0);
    for (let i = 0; i < sample.length; i++) freq[sample[i]]++;
    for (let i = 0; i < 256; i++) {
      if (freq[i] > 0) {
        const p = freq[i] / sample.length;
        entropy -= p * Math.log2(p);
      }
    }
  }

  if (entropy < 3.0) {
    rejectReasons.push("low_detail_output");
    skinRealismScore = 30;
  }

  const overallScore = Math.round((premiumLookScore + skinRealismScore + 70 + 70 + 70) / 5);

  // Conservative defaults for 3-score system when visual judge unavailable
  const identityScore = 0.75;
  const expressionScore = 0.75;
  const noveltyScore = 0.60;

  return {
    identityScore,
    expressionScore,
    noveltyScore,
    likenessScore: 75,
    ageDriftScore: 75,
    skinRealismScore,
    eyeConsistencyScore: 75,
    premiumLookScore,
    overallPass: rejectReasons.length === 0,
    overallScore,
    rejectReasons,
    rerollMode: null,
  };
}

/**
 * Main quality gate evaluation.
 * Tries multimodal judge first, falls back to rule-based.
 */
export async function evaluateGeneratedPhoto(
  referenceBase64: string,
  generatedBase64: string,
  generatedBuffer: Buffer,
  mimeType: string,
  style: string,
  generationId: string,
  imageIndex: number
): Promise<QualityGateResult> {
  const startTime = Date.now();

  // Try multimodal judge first (only for premium, skip if env says disabled)
  const useMultimodal = process.env.QUALITY_GATE_MULTIMODAL !== "false";
  let score: QualityScore | null = null;
  let method: "multimodal_judge" | "rule_based_fallback" = "rule_based_fallback";

  if (useMultimodal) {
    score = await multimodalJudge(referenceBase64, generatedBase64, mimeType, style);
    if (score) method = "multimodal_judge";
  }

  if (!score) {
    score = ruleBasedFallback(generatedBuffer, style);
  }

  const elapsed = Date.now() - startTime;

  // Determine if reroll is warranted (disabled this week: MAX_RETRIES=0)
  const rerollKey = `${generationId}_${imageIndex}`;
  const currentRerolls = rerollCounts.get(rerollKey) || 0;
  const shouldReroll = false; // Disabled: MAX_RETRIES is 0 this week

  // JSON structured logging for analysis (log what WOULD retry)
  const wouldReroll = !score.overallPass && currentRerolls < MAX_RETRIES;
  if (wouldReroll) {
    rerollCounts.set(rerollKey, currentRerolls + 1);
  }

  console.log(JSON.stringify({
    event: "quality_gate_eval",
    generationId,
    imageIndex,
    identityScore: score.identityScore,
    expressionScore: score.expressionScore,
    noveltyScore: score.noveltyScore,
    overallPass: score.overallPass,
    shouldReroll: false, // Hard disabled this week
    wouldReroll, // What would happen if retries enabled
    rerollMode: score.rerollMode,
    rejectReasons: score.rejectReasons,
    evaluationTimeMs: elapsed,
    timestamp: new Date().toISOString()
  }));

  return {
    score,
    shouldReroll: false, // Always false this week
    rerollMode: score.rerollMode,
    evaluationMethod: method,
    evaluationTimeMs: elapsed,
  };
}

/**
 * Clear reroll tracking for a completed generation.
 * Call this after generation batch completes to prevent memory leak.
 */
export function clearRerollTracking(generationId: string) {
  for (const key of rerollCounts.keys()) {
    if (key.startsWith(generationId)) {
      rerollCounts.delete(key);
    }
  }
}
