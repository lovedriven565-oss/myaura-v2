// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V6.0 — Post-Generation Quality Gate (stub)
// ═════════════════════════════════════════════════════════════════════════════
//
// V6.0 relies on Imagen 3 Subject Customization with a FACE_MESH control
// reference to preserve identity at model level — the multimodal LLM judge
// has been retired (months of evidence that the judge was producing false
// rejections on valid Gemini outputs and stalling reroll logic).
//
// This module keeps the same exported interface so callers need no changes,
// but always returns "pass" with no reroll. Reroll counting is retained for
// callers that still track it per-generation.
// ═════════════════════════════════════════════════════════════════════════════

export interface QualityScore {
  likenessScore: number;
  ageDriftScore: number;
  skinRealismScore: number;
  eyeConsistencyScore: number;
  premiumLookScore: number;
  expressionScore: number;
  overallPass: boolean;
  overallScore: number;
  rejectReasons: string[];
}

export interface QualityGateResult {
  score: QualityScore;
  shouldReroll: boolean;
  evaluationMethod: "skipped";
  evaluationTimeMs: number;
  judgeModel?: string;
}

// Per-generation reroll bookkeeping. Exported cleaner for callers to purge
// after a generation completes (avoids memory accumulation on long-lived
// workers).
const rerollCounts = new Map<string, number>();

export function clearRerollTracking(generationId: string): void {
  for (const key of rerollCounts.keys()) {
    if (key.startsWith(generationId)) rerollCounts.delete(key);
  }
}

/**
 * No-op evaluation. Returns pass:true unconditionally. Kept as a function
 * so the generation pipeline can still call it without a shape change.
 */
export async function evaluateGeneratedPhoto(
  _referenceBase64: string,
  _generatedBase64: string,
  _generatedBuffer: Buffer,
  _mimeType: string,
  _style: string,
  _generationId: string,
  _imageIndex: number,
): Promise<QualityGateResult> {
  return {
    score: {
      likenessScore: 80,
      ageDriftScore: 80,
      skinRealismScore: 80,
      eyeConsistencyScore: 80,
      premiumLookScore: 80,
      expressionScore: 80,
      overallPass: true,
      overallScore: 80,
      rejectReasons: [],
    },
    shouldReroll: false,
    evaluationMethod: "skipped",
    evaluationTimeMs: 0,
  };
}
