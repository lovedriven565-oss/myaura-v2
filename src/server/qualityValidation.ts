/**
 * Quality Validation Framework v2
 * 
 * Standalone module for measuring AI photo quality across 4 control modes.
 * NOT imported by any runtime code — used only via validation endpoint or CLI.
 * 
 * Modes:
 *   baseline          — old prompt, no curation, no quality gate
 *   prompt_only       — new modular prompt, no curation, no quality gate
 *   prompt_plus_curation — new prompt + input curation, no quality gate
 *   full_current      — new prompt + curation + quality gate with reroll
 * 
 * Metrics per image (scored 0-100 by Gemini multimodal judge):
 *   likeness, ageRealism, skinRealism, eyeConsistency, premiumLook,
 *   batchConsistencyScore, styleFidelityScore
 * 
 * Failure taxonomy tags:
 *   identity_drift, age_drift, plastic_skin, eye_distortion,
 *   weak_style_match, low_premium_feel, over_retouch, under_retouch
 */

import { GoogleGenAI } from "@google/genai";
import { aiProvider } from "./ai.js";
import { storage } from "./storage.js";
import { StyleId } from "./prompts.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ValidationMode = "baseline" | "prompt_only" | "prompt_plus_curation" | "full_current";

export type FailureTag =
  | "identity_drift"
  | "age_drift"
  | "plastic_skin"
  | "eye_distortion"
  | "weak_style_match"
  | "low_premium_feel"
  | "over_retouch"
  | "under_retouch";

export interface QualityMetrics {
  likeness: number;
  ageRealism: number;
  skinRealism: number;
  eyeConsistency: number;
  premiumLook: number;
  batchConsistencyScore: number;
  styleFidelityScore: number;
  overall: number;
  failureTags: FailureTag[];
}

export interface RunResult {
  mode: ValidationMode;
  styleId: string;
  runIndex: number;
  metrics: QualityMetrics;
  rerolled: boolean;
  imagePath?: string;
  generationTimeMs: number;
  judgeTimeMs: number;
}

export interface StatBlock {
  avg: number;
  min: number;
  max: number;
  stddev: number;
}

export interface StyleModeStats {
  styleId: string;
  runs: number;
  likeness: StatBlock;
  ageRealism: StatBlock;
  skinRealism: StatBlock;
  eyeConsistency: StatBlock;
  premiumLook: StatBlock;
  batchConsistency: StatBlock;
  styleFidelity: StatBlock;
  overall: StatBlock;
  rerollCount: number;
  dominantFailures: Record<string, number>;
}

export interface ModeStats {
  mode: ValidationMode;
  styles: StyleModeStats[];
  aggregateOverall: StatBlock;
  totalGenerations: number;
  totalJudgeCalls: number;
  totalRerolls: number;
}

export interface ValidationReport {
  testId: string;
  timestamp: number;
  config: {
    modes: ValidationMode[];
    styles: string[];
    runsPerStyle: number;
  };
  modeReports: ModeStats[];
  deltas: Record<string, Record<string, number>>;
  scientificReport: string;
  productReport: string;
  recommendations: string[];
  humanReviewPaths: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ALL_MODES: ValidationMode[] = ["baseline", "prompt_only", "prompt_plus_curation", "full_current"];
const TEST_STYLES: string[] = ["business", "cinematic", "luxury", "aura"];
const DELAY_BETWEEN_GENERATIONS_MS = 10_000;

// ─── Baseline Prompt (pre-refactor, embedded for reproducibility) ───────────

const BASELINE_IDENTITY = `
CRITICAL REQUIREMENTS:
- Preserve EXACT facial identity from the original image.
- Preserve facial geometry, bone structure, and features exactly.
- Preserve age and gender presentation exactly as in the original.
- Preserve ethnicity and skin tone.
- Preserve natural skin texture (do NOT over-smooth, no plastic skin).
- Do NOT perform face replacement.
- Do NOT make the subject look like a child if they are an adult (no childification).
- Maintain realistic proportions.
`;

const BASELINE_QUALITY = `
NEGATIVE CONSTRAINTS:
- No cartoonish looks, no 3D render style, no plastic skin.
- No extreme depth of field that blurs the subject's face.
- Avoid unnatural lighting artifacts or weird eye reflections.
`;

const BASELINE_PREMIUM_LAYER = `
STYLE TASK: Create a premium, high-end, highly polished portrait.
This is a paid result. The image must look expensive, with richer light, deep colors, and magazine-quality finish.
The subject must look their absolute best while maintaining 100% likeness.
`;

const BASELINE_STYLES: Record<string, string> = {
  business: "Business headshot style: Sharp suit, confident expression, high-end corporate studio lighting, neutral or modern office background.",
  lifestyle: "Premium lifestyle style: Natural soft sunlight, relaxed but elegant pose, high-end interior or blurred outdoor background.",
  aura: "Aura signature style: Soft, glowing ethereal light, subtle pastel color accents, highly aesthetic and moody, dreamy but realistic.",
  cinematic: "Cinematic style: Deep dramatic shadows, moody teal and orange or rich cinematic color grading, movie still quality.",
  luxury: "Luxury style: 'Old money' aesthetic, elegant evening wear or expensive casual wear, rich textures, luxurious environment.",
  editorial: "Studio Editorial style: High-fashion magazine cover look, striking dramatic flash lighting, vanguard styling, bold contrast."
};

function buildBaselinePrompt(styleId: string): string {
  const stylePrompt = BASELINE_STYLES[styleId] || BASELINE_STYLES["business"];
  return [
    BASELINE_IDENTITY.trim(),
    BASELINE_PREMIUM_LAYER.trim(),
    "SPECIFIC STYLE:",
    stylePrompt.trim(),
    BASELINE_QUALITY.trim()
  ].join("\n\n");
}

// ─── Current Prompt (imports from prompts.ts) ───────────────────────────────

async function buildCurrentPrompt(styleId: string): Promise<{ prompt: string; negativePrompt: string }> {
  const { buildPrompt } = await import("./prompts.js");
  return buildPrompt("premium", styleId as StyleId);
}

// ─── Input Curation (conditional) ───────────────────────────────────────────

async function curateInputs(
  imageFiles: { buffer: Buffer; originalname: string }[]
): Promise<{ buffer: Buffer; originalname: string }[]> {
  const { selectBestReferencePhotos } = await import("./inputCuration.js");
  const result = await selectBestReferencePhotos(imageFiles);
  if (result.selectedIndices.length > 0) {
    return result.selectedIndices.map(i => imageFiles[i]);
  }
  return imageFiles;
}

// ─── Quality Gate (conditional) ──────────────────────────────────────────────

async function runQualityGate(
  referenceBase64: string,
  generatedBase64: string,
  generatedBuffer: Buffer,
  mimeType: string,
  styleId: string,
  genId: string,
  index: number
): Promise<{ shouldReroll: boolean; score: number }> {
  const { evaluateGeneratedPhoto } = await import("./qualityGate.js");
  const result = await evaluateGeneratedPhoto(
    referenceBase64, generatedBase64, generatedBuffer, mimeType, styleId as StyleId, genId, index
  );
  return { shouldReroll: result.shouldReroll, score: result.score.overallScore };
}

// ─── Gemini Judge ───────────────────────────────────────────────────────────

async function judgePhoto(
  referenceBase64: string,
  generatedBase64: string,
  mimeType: string,
  styleId: string
): Promise<QualityMetrics> {
  const startTime = Date.now();

  const judgePrompt = `You are a professional photography quality judge. Evaluate this AI-generated portrait against the reference photo.

Style requested: "${styleId}"

Score each dimension 0-100:
- likeness: Does the face match the reference? (bone structure, features, identity)
- ageRealism: Is the apparent age consistent with reference? (100 = same age, 0 = severe drift)
- skinRealism: Is skin texture natural? (100 = real skin, 0 = plastic/wax)
- eyeConsistency: Are eyes natural with correct color? (100 = perfect, 0 = distorted)
- premiumLook: Does it look like expensive professional photography? (100 = magazine quality)
- batchConsistencyScore: Would this image look consistent with others in a set? (100 = very consistent)
- styleFidelityScore: Does it match the requested "${styleId}" style? (100 = perfect match)

Also identify failure tags from this list (only include those that apply):
identity_drift, age_drift, plastic_skin, eye_distortion, weak_style_match, low_premium_feel, over_retouch, under_retouch

Respond ONLY with valid JSON, no markdown:
{
  "likeness": <number>,
  "ageRealism": <number>,
  "skinRealism": <number>,
  "eyeConsistency": <number>,
  "premiumLook": <number>,
  "batchConsistencyScore": <number>,
  "styleFidelityScore": <number>,
  "failureTags": [<string>, ...]
}`;

  try {
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    const location = process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'global';
    let ai = new GoogleGenAI({ vertexai: true, project, location } as any);

    let response;
    try {
      response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [
          { inlineData: { data: referenceBase64, mimeType } },
          { inlineData: { data: generatedBase64, mimeType } },
          { text: judgePrompt }
        ]
      });
    } catch (err: any) {
      if (err?.status === 403 || err?.message?.includes("Permission denied") || err?.message?.includes("may not exist")) {
        console.warn(`[QualityValidation] 403 denied for gemini-2.0-flash in ${location}. Retrying in us-central1...`);
        ai = new GoogleGenAI({ vertexai: true, project, location: 'us-central1' } as any);
        response = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: [
            { inlineData: { data: referenceBase64, mimeType } },
            { inlineData: { data: generatedBase64, mimeType } },
            { text: judgePrompt }
          ]
        });
      } else {
        throw err;
      }
    }

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[Judge] No JSON in response, using fallback scores");
      return fallbackMetrics();
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const metrics: QualityMetrics = {
      likeness: clamp(parsed.likeness ?? 50),
      ageRealism: clamp(parsed.ageRealism ?? 50),
      skinRealism: clamp(parsed.skinRealism ?? 50),
      eyeConsistency: clamp(parsed.eyeConsistency ?? 50),
      premiumLook: clamp(parsed.premiumLook ?? 50),
      batchConsistencyScore: clamp(parsed.batchConsistencyScore ?? 50),
      styleFidelityScore: clamp(parsed.styleFidelityScore ?? 50),
      overall: 0,
      failureTags: (parsed.failureTags || []).filter((t: string) => VALID_FAILURE_TAGS.has(t as FailureTag)) as FailureTag[]
    };

    metrics.overall = Math.round(
      (metrics.likeness * 0.25 +
        metrics.ageRealism * 0.15 +
        metrics.skinRealism * 0.15 +
        metrics.eyeConsistency * 0.10 +
        metrics.premiumLook * 0.15 +
        metrics.batchConsistencyScore * 0.10 +
        metrics.styleFidelityScore * 0.10) * 100
    ) / 100;

    const judgeTime = Date.now() - startTime;
    console.log(`[Judge] ${styleId}: overall=${metrics.overall}, tags=${metrics.failureTags.join(",") || "none"} (${judgeTime}ms)`);

    return metrics;
  } catch (err: any) {
    console.error("[Judge] Error:", err.message);
    return fallbackMetrics();
  }
}

const VALID_FAILURE_TAGS = new Set<FailureTag>([
  "identity_drift", "age_drift", "plastic_skin", "eye_distortion",
  "weak_style_match", "low_premium_feel", "over_retouch", "under_retouch"
]);

function clamp(v: number): number { return Math.max(0, Math.min(100, Math.round(v))); }

function fallbackMetrics(): QualityMetrics {
  return {
    likeness: 50, ageRealism: 50, skinRealism: 50, eyeConsistency: 50,
    premiumLook: 50, batchConsistencyScore: 50, styleFidelityScore: 50,
    overall: 50, failureTags: []
  };
}

// ─── Statistics ─────────────────────────────────────────────────────────────

function computeStats(values: number[]): StatBlock {
  if (values.length === 0) return { avg: 0, min: 0, max: 0, stddev: 0 };
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  const stddev = Math.round(Math.sqrt(variance) * 100) / 100;
  return {
    avg: Math.round(avg * 100) / 100,
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    stddev
  };
}

// ─── Generation Per Mode ────────────────────────────────────────────────────

async function generateForMode(
  mode: ValidationMode,
  styleId: string,
  referenceBase64: string,
  mimeType: string,
  additionalImages: string[],
  allFileBuffers: Buffer[]
): Promise<{ base64: string; rerolled: boolean; generationTimeMs: number }> {
  const genStart = Date.now();

  // Build prompt based on mode
  let prompt: string;
  if (mode === "baseline") {
    prompt = buildBaselinePrompt(styleId);
  } else {
    const current = await buildCurrentPrompt(styleId);
    prompt = current.prompt;
  }

  // Determine which images to use
  let refBase64 = referenceBase64;
  let addImages = additionalImages;

  if ((mode === "prompt_plus_curation" || mode === "full_current") && allFileBuffers.length > 1) {
    const fileObjs = allFileBuffers.map((buf, i) => ({ buffer: buf, originalname: `ref_${i}.jpg` }));
    const curated = await curateInputs(fileObjs);
    refBase64 = curated[0].buffer.toString("base64");
    addImages = curated.slice(1).map(f => f.buffer.toString("base64"));
  }

  // Generate
  let resultBase64 = await aiProvider.generateImage(refBase64, mimeType, prompt, "premium", addImages);
  let rerolled = false;

  // Quality gate (only for full_current)
  if (mode === "full_current") {
    const resultBuffer = Buffer.from(resultBase64, "base64");
    const gate = await runQualityGate(refBase64, resultBase64, resultBuffer, mimeType, styleId, `val_${Date.now()}`, 0);
    if (gate.shouldReroll) {
      console.log(`[Validation] ${mode}/${styleId}: quality gate failed (score=${gate.score}), rerolling...`);
      resultBase64 = await aiProvider.generateImage(refBase64, mimeType, prompt, "premium", addImages);
      rerolled = true;
    }
  }

  return { base64: resultBase64, rerolled, generationTimeMs: Date.now() - genStart };
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function runQualityValidation(
  referenceBase64: string,
  mimeType: string,
  additionalImages: string[],
  options?: {
    modes?: ValidationMode[];
    styles?: string[];
    runsPerStyle?: number;
    saveImages?: boolean;
  }
): Promise<ValidationReport> {
  const testId = `val_${Date.now()}`;
  const modes = options?.modes || ALL_MODES;
  const styles = options?.styles || TEST_STYLES;
  const runsPerStyle = options?.runsPerStyle || 3;
  const saveImages = options?.saveImages !== false;

  // Reconstruct file buffers for input curation
  const refBuffer = Buffer.from(referenceBase64, "base64");
  const allFileBuffers = [refBuffer, ...(additionalImages || []).map(b64 => Buffer.from(b64, "base64"))];

  const allRuns: RunResult[] = [];
  const humanReviewPaths: string[] = [];

  console.log(`[Validation] Starting ${testId}: ${modes.length} modes × ${styles.length} styles × ${runsPerStyle} runs = ${modes.length * styles.length * runsPerStyle} generations`);

  for (const mode of modes) {
    console.log(`[Validation] ── Mode: ${mode} ──`);

    for (const styleId of styles) {
      for (let runIdx = 0; runIdx < runsPerStyle; runIdx++) {
        // Throttle
        if (allRuns.length > 0) {
          await new Promise(r => setTimeout(r, DELAY_BETWEEN_GENERATIONS_MS));
        }

        try {
          console.log(`[Validation] ${mode}/${styleId} run ${runIdx + 1}/${runsPerStyle}`);

          const gen = await generateForMode(mode, styleId, referenceBase64, mimeType, additionalImages, allFileBuffers);

          // Save image to R2 if requested
          let imagePath: string | undefined;
          if (saveImages) {
            try {
              const buf = Buffer.from(gen.base64, "base64");
              const filename = `validation/${testId}/${mode}/${styleId}_run${runIdx}.jpg`;
              imagePath = await storage.save(buf, filename, "result");
              humanReviewPaths.push(imagePath);
            } catch (saveErr: any) {
              console.warn(`[Validation] Failed to save image: ${saveErr.message}`);
            }
          }

          // Judge
          const judgeStart = Date.now();
          const metrics = await judgePhoto(referenceBase64, gen.base64, mimeType, styleId);
          const judgeTimeMs = Date.now() - judgeStart;

          allRuns.push({
            mode,
            styleId,
            runIndex: runIdx,
            metrics,
            rerolled: gen.rerolled,
            imagePath,
            generationTimeMs: gen.generationTimeMs,
            judgeTimeMs
          });
        } catch (err: any) {
          console.error(`[Validation] ${mode}/${styleId} run ${runIdx} failed: ${err.message}`);
          allRuns.push({
            mode,
            styleId,
            runIndex: runIdx,
            metrics: fallbackMetrics(),
            rerolled: false,
            generationTimeMs: 0,
            judgeTimeMs: 0
          });
        }
      }
    }
  }

  // Aggregate stats
  const modeReports: ModeStats[] = modes.map(mode => {
    const modeRuns = allRuns.filter(r => r.mode === mode);

    const styleStats: StyleModeStats[] = styles.map(styleId => {
      const styleRuns = modeRuns.filter(r => r.styleId === styleId);
      const failureCounts: Record<string, number> = {};

      for (const run of styleRuns) {
        for (const tag of run.metrics.failureTags) {
          failureCounts[tag] = (failureCounts[tag] || 0) + 1;
        }
      }

      return {
        styleId,
        runs: styleRuns.length,
        likeness: computeStats(styleRuns.map(r => r.metrics.likeness)),
        ageRealism: computeStats(styleRuns.map(r => r.metrics.ageRealism)),
        skinRealism: computeStats(styleRuns.map(r => r.metrics.skinRealism)),
        eyeConsistency: computeStats(styleRuns.map(r => r.metrics.eyeConsistency)),
        premiumLook: computeStats(styleRuns.map(r => r.metrics.premiumLook)),
        batchConsistency: computeStats(styleRuns.map(r => r.metrics.batchConsistencyScore)),
        styleFidelity: computeStats(styleRuns.map(r => r.metrics.styleFidelityScore)),
        overall: computeStats(styleRuns.map(r => r.metrics.overall)),
        rerollCount: styleRuns.filter(r => r.rerolled).length,
        dominantFailures: failureCounts
      };
    });

    return {
      mode,
      styles: styleStats,
      aggregateOverall: computeStats(modeRuns.map(r => r.metrics.overall)),
      totalGenerations: modeRuns.length + modeRuns.filter(r => r.rerolled).length,
      totalJudgeCalls: modeRuns.length,
      totalRerolls: modeRuns.filter(r => r.rerolled).length
    };
  });

  // Compute deltas vs baseline
  const baselineOverall = modeReports.find(m => m.mode === "baseline")?.aggregateOverall.avg || 0;
  const deltas: Record<string, Record<string, number>> = {};

  for (const report of modeReports) {
    if (report.mode === "baseline") continue;
    const baselineMode = modeReports.find(m => m.mode === "baseline");
    if (!baselineMode) continue;

    const delta: Record<string, number> = {};
    delta.overall = Math.round((report.aggregateOverall.avg - baselineOverall) * 100) / 100;

    const metricKeys = ["likeness", "ageRealism", "skinRealism", "eyeConsistency", "premiumLook", "batchConsistency", "styleFidelity"];
    for (const key of metricKeys) {
      const baseAvg = computeStats(
        modeReports.find(m => m.mode === "baseline")!.styles.flatMap(s => {
          const val = (s as any)[key]?.avg;
          return val !== undefined ? [val] : [];
        })
      ).avg;
      const currentAvg = computeStats(
        report.styles.flatMap(s => {
          const val = (s as any)[key]?.avg;
          return val !== undefined ? [val] : [];
        })
      ).avg;
      delta[key] = Math.round((currentAvg - baseAvg) * 100) / 100;
    }

    deltas[report.mode] = delta;
  }

  // Build reports
  const scientificReport = buildScientificReport(modeReports, deltas, testId);
  const productReport = buildProductReport(modeReports, deltas);
  const recommendations = buildRecommendations(modeReports, deltas);

  const report: ValidationReport = {
    testId,
    timestamp: Date.now(),
    config: { modes, styles, runsPerStyle },
    modeReports,
    deltas,
    scientificReport,
    productReport,
    recommendations,
    humanReviewPaths
  };

  console.log("\n" + scientificReport);

  return report;
}

// ─── Scientific Report ──────────────────────────────────────────────────────

function buildScientificReport(modes: ModeStats[], deltas: Record<string, Record<string, number>>, testId: string): string {
  let md = `# Scientific Validation Report — ${testId}\n\n`;
  md += `Generated: ${new Date().toISOString()}\n\n`;

  md += `## Mechanism Attribution\n\n`;
  md += `| Metric | prompt_only Δ | +curation Δ | full_current Δ |\n`;
  md += `|--------|:------------:|:-----------:|:--------------:|\n`;

  const metricLabels: Record<string, string> = {
    overall: "Overall",
    likeness: "Likeness",
    ageRealism: "Age Realism",
    skinRealism: "Skin Realism",
    eyeConsistency: "Eye Consistency",
    premiumLook: "Premium Look",
    batchConsistency: "Batch Consistency",
    styleFidelity: "Style Fidelity"
  };

  for (const [key, label] of Object.entries(metricLabels)) {
    const p = deltas["prompt_only"]?.[key] ?? "N/A";
    const c = deltas["prompt_plus_curation"]?.[key] ?? "N/A";
    const f = deltas["full_current"]?.[key] ?? "N/A";
    const fmt = (v: any) => typeof v === "number" ? (v >= 0 ? `+${v}` : `${v}`) : v;
    md += `| ${label} | ${fmt(p)} | ${fmt(c)} | ${fmt(f)} |\n`;
  }

  md += `\n## Per-Mode Overview\n\n`;
  for (const modeReport of modes) {
    md += `### ${modeReport.mode}\n`;
    md += `- **Overall**: avg=${modeReport.aggregateOverall.avg}, σ=${modeReport.aggregateOverall.stddev}\n`;
    md += `- **Generations**: ${modeReport.totalGenerations} (rerolls: ${modeReport.totalRerolls})\n`;
    md += `- **Judge calls**: ${modeReport.totalJudgeCalls}\n\n`;
  }

  md += `## Stability Analysis\n\n`;
  for (const modeReport of modes) {
    md += `- **${modeReport.mode}**: stddev=${modeReport.aggregateOverall.stddev} (range: ${modeReport.aggregateOverall.min}–${modeReport.aggregateOverall.max})\n`;
  }

  md += `\n## Failure Taxonomy\n\n`;
  const fullMode = modes.find(m => m.mode === "full_current") || modes[modes.length - 1];
  for (const s of fullMode.styles) {
    const issues = Object.entries(s.dominantFailures);
    if (issues.length > 0) {
      md += `- **${s.styleId}**: ${issues.map(([t, c]) => `${t}(${c}/${s.runs})`).join(", ")}\n`;
    } else {
      md += `- **${s.styleId}**: No dominant failures\n`;
    }
  }

  return md;
}

// ─── Product Report ─────────────────────────────────────────────────────────

function buildProductReport(modes: ModeStats[], deltas: Record<string, Record<string, number>>): string {
  let md = `# Product Quality Report\n\n`;

  const fullMode = modes.find(m => m.mode === "full_current");
  if (!fullMode) {
    md += "No full_current mode data available.\n";
    return md;
  }

  md += `## Current Quality (full pipeline)\n\n`;
  md += `| Style | Overall | Likeness | Skin | Premium | Style Match |\n`;
  md += `|-------|:-------:|:--------:|:----:|:-------:|:-----------:|\n`;

  for (const s of fullMode.styles) {
    md += `| ${s.styleId} | ${s.overall.avg} | ${s.likeness.avg} | ${s.skinRealism.avg} | ${s.premiumLook.avg} | ${s.styleFidelity.avg} |\n`;
  }

  const baselineMode = modes.find(m => m.mode === "baseline");
  if (baselineMode) {
    md += `\n## Improvement vs Baseline\n\n`;
    const d = deltas["full_current"] || {};
    md += `- **Overall**: ${d.overall >= 0 ? "+" : ""}${d.overall}\n`;
    md += `- **Likeness**: ${d.likeness >= 0 ? "+" : ""}${d.likeness}\n`;
    md += `- **Skin Realism**: ${d.skinRealism >= 0 ? "+" : ""}${d.skinRealism}\n`;
    md += `- **Premium Look**: ${d.premiumLook >= 0 ? "+" : ""}${d.premiumLook}\n`;
  }

  md += `\n## Style-Specific Issues\n\n`;
  for (const s of fullMode.styles) {
    const issues = Object.entries(s.dominantFailures);
    if (issues.length > 0) {
      md += `- **${s.styleId}**: ${issues.map(([t, c]) => `${t}(${c}x)`).join(", ")}\n`;
    } else {
      md += `- **${s.styleId}**: Clean ✓\n`;
    }
  }

  return md;
}

// ─── Recommendations ────────────────────────────────────────────────────────

function buildRecommendations(modes: ModeStats[], deltas: Record<string, Record<string, number>>): string[] {
  const recs: string[] = [];
  const promptDelta = deltas["prompt_only"] || {};
  const curationDelta = deltas["prompt_plus_curation"] || {};
  const fullDelta = deltas["full_current"] || {};

  // Prompt refactor impact
  if ((promptDelta.overall || 0) > 3) {
    recs.push("KEEP: Prompt refactor shows positive impact (" + (promptDelta.overall > 0 ? "+" : "") + promptDelta.overall?.toFixed(1) + " overall)");
  } else if ((promptDelta.overall || 0) < -3) {
    recs.push("INVESTIGATE: Prompt refactor shows negative impact — review style-specific modifiers");
  } else {
    recs.push("NEUTRAL: Prompt refactor has minimal impact on scores — monitor on more test cases");
  }

  // Curation impact
  const curationVsPrompt = (curationDelta.overall || 0) - (promptDelta.overall || 0);
  if (curationVsPrompt > 2) {
    recs.push(`KEEP: Input curation adds measurable quality lift (+${curationVsPrompt.toFixed(1)} over prompt alone)`);
  } else if (curationVsPrompt < -2) {
    recs.push("INVESTIGATE: Input curation may be removing useful photos — check curation thresholds");
  } else {
    recs.push("NEUTRAL: Input curation has minimal incremental impact — review selection criteria");
  }

  // Quality gate impact
  const gateVsCuration = (fullDelta.overall || 0) - (curationDelta.overall || 0);
  if (gateVsCuration > 2) {
    recs.push(`KEEP: Quality gate with reroll improves output (+${gateVsCuration.toFixed(1)} over curation alone)`);
  } else if (gateVsCuration < 0) {
    recs.push("INVESTIGATE: Quality gate may be too aggressive — review pass threshold");
  } else {
    recs.push("MONITOR: Quality gate has minimal impact — threshold may be too lenient");
  }

  // Skin realism check
  const fullMode = modes.find(m => m.mode === "full_current");
  if (fullMode) {
    for (const s of fullMode.styles) {
      if (s.skinRealism.avg < 60) {
        recs.push(`WARN: ${s.styleId} has low skin realism (${s.skinRealism.avg}) — check retouchPolicy and negativePrompt`);
      }
      if (s.likeness.avg < 55) {
        recs.push(`WARN: ${s.styleId} has low likeness (${s.likeness.avg}) — identity may be drifting in this style`);
      }
    }
  }

  // Cost summary
  const totalGens = modes.reduce((s, m) => s + m.totalGenerations, 0);
  const totalRerolls = modes.reduce((s, m) => s + m.totalRerolls, 0);
  recs.push(`COST: ${totalGens} total generations (${totalRerolls} rerolls) across ${modes.length} modes`);

  return recs;
}
