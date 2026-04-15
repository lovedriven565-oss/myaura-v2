/**
 * Input Curation Module v2.0 — Mode-Aware Reference Photo Selection
 *
 * Strategies:
 *   FREE    — up to 5 uploads → select best 3 (fast, cheap, first-wow)
 *   PREMIUM — 10-15 uploads → balanced identity pack (frontal + angles, deduped)
 *
 * Scoring: file size, entropy, brightness, variance, image dimensions (via Sharp).
 * No external ML — pragmatic heuristics + Sharp metadata only.
 */

import sharp from "sharp";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PhotoScore {
  index: number;
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  score: number;
  passed: boolean;
  selected: boolean;
  reasons: string[];
  aspectRatio: number;       // width/height — helps detect frontal vs landscape crops
  isLikelyPortrait: boolean; // aspect ratio < 1.0 (taller than wide)
}

export interface CurationOptions {
  mode: "free" | "premium";
}

export interface CurationTelemetry {
  mode: string;
  uploadedCount: number;
  passedCount: number;
  dedupedCount: number;
  selectedCount: number;
  rejectedCount: number;
  rejectionReasons: string[];
  selectedIndices: number[];
  latencyMs: number;
  hardReject: boolean;
}

export interface CurationResult {
  selectedIndices: number[];
  allScores: PhotoScore[];
  warnings: string[];
  hardReject: boolean;
  hardRejectReason?: string;
  telemetry: CurationTelemetry;
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

const MIN_FILE_SIZE = parseInt(process.env.CURATION_MIN_FILE_SIZE || "30000");  // 30KB
const MAX_FILE_SIZE = parseInt(process.env.CURATION_MAX_FILE_SIZE || "10485760"); // 10MB
const MIN_DIMENSION = 256;      // pixels — below this the face is too small
const DUPLICATE_THRESHOLD = 0.97;

// Mode-specific selection targets
const FREE_TARGET_SELECTION = 3;
const FREE_MIN_ACCEPTABLE = 1;   // free must work even with 1 good photo
const PREMIUM_TARGET_SELECTION = parseInt(process.env.CURATION_TARGET_SELECTION || "8");
const PREMIUM_MIN_ACCEPTABLE = parseInt(process.env.CURATION_MIN_ACCEPTABLE || "3");

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Analyze a single photo buffer and return quality metrics.
 * Uses Sharp for dimensions + lightweight buffer heuristics.
 */
async function analyzePhoto(buffer: Buffer, filename: string, index: number): Promise<PhotoScore> {
  const reasons: string[] = [];
  let score = 50; // start neutral
  const sizeBytes = buffer.length;

  // 0. Image dimensions via Sharp (fast metadata read, no pixel decode)
  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(buffer).metadata();
    width = meta.width || 0;
    height = meta.height || 0;
  } catch {
    reasons.push("sharp_metadata_failed");
    score -= 10;
  }

  if (width > 0 && height > 0) {
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
      reasons.push(`too_small_dimensions: ${width}x${height} < ${MIN_DIMENSION}px`);
      score -= 30;
    } else if (width >= 1024 && height >= 1024) {
      score += 10; // high-res bonus
    }
    // Extreme aspect ratios (panoramas, banners) are poor for portraits
    const ar = width / height;
    if (ar > 2.5 || ar < 0.4) {
      reasons.push(`extreme_aspect_ratio: ${ar.toFixed(2)}`);
      score -= 15;
    }
  }

  // 1. File size scoring
  if (sizeBytes < MIN_FILE_SIZE) {
    reasons.push(`too_small: ${Math.round(sizeBytes / 1024)}KB < ${Math.round(MIN_FILE_SIZE / 1024)}KB`);
    score -= 40;
  } else if (sizeBytes < 100_000) {
    reasons.push("low_resolution_likely");
    score -= 15;
  } else if (sizeBytes > 500_000) {
    score += 10;
  }
  if (sizeBytes > 2_000_000) {
    score += 5;
  }
  if (sizeBytes > MAX_FILE_SIZE) {
    reasons.push(`too_large: ${Math.round(sizeBytes / 1048576)}MB`);
    score -= 10;
  }

  // 2. Entropy (detail proxy)
  const entropy = estimateEntropy(buffer.slice(0, Math.min(buffer.length, 8192)));
  if (entropy < 4.0) {
    reasons.push("low_entropy: heavy compression or uniform image");
    score -= 20;
  } else if (entropy > 6.5) {
    score += 10;
  }

  // 3. Brightness
  const brightness = estimateBrightness(buffer);
  if (brightness < 40) {
    reasons.push(`too_dark: brightness=${brightness}`);
    score -= 25;
  } else if (brightness > 240) {
    reasons.push(`overexposed: brightness=${brightness}`);
    score -= 25;
  } else if (brightness >= 80 && brightness <= 200) {
    score += 10;
  }

  // 4. Variance (blur proxy)
  const variance = estimateVariance(buffer);
  if (variance < 15) {
    reasons.push(`likely_blurry: variance=${variance.toFixed(1)}`);
    score -= 20;
  } else if (variance > 40) {
    score += 10;
  }

  score = Math.max(0, Math.min(100, score));
  const aspectRatio = height > 0 ? width / height : 1;
  const isLikelyPortrait = aspectRatio < 1.1;

  return {
    index,
    filename,
    sizeBytes,
    width,
    height,
    score,
    passed: score >= 30,
    selected: false,
    reasons,
    aspectRatio,
    isLikelyPortrait,
  };
}

// ─── Heuristic helpers ──────────────────────────────────────────────────────

function estimateEntropy(sample: Buffer): number {
  const freq = new Array(256).fill(0);
  for (let i = 0; i < sample.length; i++) {
    freq[sample[i]]++;
  }
  let entropy = 0;
  for (let i = 0; i < 256; i++) {
    if (freq[i] > 0) {
      const p = freq[i] / sample.length;
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

function estimateBrightness(buffer: Buffer): number {
  const start = Math.min(2048, Math.floor(buffer.length * 0.2));
  const end = Math.min(buffer.length, start + 4096);
  if (end <= start) return 128;
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) { sum += buffer[i]; count++; }
  return count > 0 ? Math.round(sum / count) : 128;
}

function estimateVariance(buffer: Buffer): number {
  const start = Math.min(2048, Math.floor(buffer.length * 0.2));
  const end = Math.min(buffer.length, start + 4096);
  if (end <= start) return 50;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = start; i < end; i++) { sum += buffer[i]; sumSq += buffer[i] * buffer[i]; count++; }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, (sumSq / count) - (mean * mean)));
}

function areSimilar(a: Buffer, b: Buffer): boolean {
  const sizeRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (sizeRatio < 0.9) return false;
  const sampleSize = 512;
  const offsetA = Math.min(2048, Math.floor(a.length * 0.3));
  const offsetB = Math.min(2048, Math.floor(b.length * 0.3));
  if (offsetA + sampleSize > a.length || offsetB + sampleSize > b.length) return false;
  let matches = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (Math.abs(a[offsetA + i] - b[offsetB + i]) < 8) matches++;
  }
  return (matches / sampleSize) > DUPLICATE_THRESHOLD;
}

// ─── Selection Strategies ───────────────────────────────────────────────────

/**
 * FREE strategy: pick top N by raw score.
 * Goal: strongest likeness with minimal latency.
 */
function selectFreeStrategy(
  deduped: PhotoScore[],
  targetCount: number,
): PhotoScore[] {
  return deduped.slice(0, targetCount);
}

/**
 * PREMIUM strategy: balanced identity pack.
 * Goal: stable identity across many generated outputs.
 *
 * Rules:
 *   1. At least 1 portrait-orientation (likely frontal) if available
 *   2. At least 1 non-portrait (likely slight angle) if available
 *   3. Fill remaining slots by score, avoiding duplicates
 *   4. Prefer diversity over stacking near-identical high-scorers
 */
function selectPremiumStrategy(
  deduped: PhotoScore[],
  targetCount: number,
): PhotoScore[] {
  if (deduped.length <= targetCount) return deduped;

  const selected: PhotoScore[] = [];
  const used = new Set<number>();

  // Pass 1: guarantee at least 1 portrait-orientation if available
  const bestPortrait = deduped.find(s => s.isLikelyPortrait && !used.has(s.index));
  if (bestPortrait) {
    selected.push(bestPortrait);
    used.add(bestPortrait.index);
  }

  // Pass 2: guarantee at least 1 non-portrait (angle/environmental) if available
  const bestAngle = deduped.find(s => !s.isLikelyPortrait && !used.has(s.index));
  if (bestAngle) {
    selected.push(bestAngle);
    used.add(bestAngle.index);
  }

  // Pass 3: fill remaining slots by score
  for (const candidate of deduped) {
    if (selected.length >= targetCount) break;
    if (!used.has(candidate.index)) {
      selected.push(candidate);
      used.add(candidate.index);
    }
  }

  return selected;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Mode-aware photo curation.
 *   FREE    → up to 5 in, top 3 out
 *   PREMIUM → 10-15 in, balanced identity pack out
 */
export async function selectBestReferencePhotos(
  files: { buffer: Buffer; originalname: string }[],
  options: CurationOptions = { mode: "premium" },
): Promise<CurationResult> {
  const startMs = Date.now();
  const { mode } = options;
  const warnings: string[] = [];
  const rejectionReasons: string[] = [];

  const isFree = mode === "free";
  const targetSelection = isFree ? FREE_TARGET_SELECTION : PREMIUM_TARGET_SELECTION;
  const minAcceptable = isFree ? FREE_MIN_ACCEPTABLE : PREMIUM_MIN_ACCEPTABLE;

  // Score all photos (parallel Sharp metadata reads)
  const allScores = await Promise.all(
    files.map((file, idx) => analyzePhoto(file.buffer, file.originalname, idx))
  );

  // Collect rejection reasons
  for (const s of allScores) {
    if (!s.passed) {
      rejectionReasons.push(...s.reasons);
    }
  }

  const passed = allScores.filter(s => s.passed);

  if (passed.length < minAcceptable) {
    const latencyMs = Date.now() - startMs;
    return {
      selectedIndices: [],
      allScores,
      warnings: [
        `Only ${passed.length}/${files.length} photos passed quality check (minimum ${minAcceptable}).`,
        "Tips: Use good lighting, show face clearly, avoid filters, use different angles."
      ],
      hardReject: true,
      hardRejectReason: `Недостаточно качественных фото. Прошло проверку: ${passed.length} из ${files.length}. Рекомендации: хорошее освещение, лицо крупным планом, без фильтров, разные ракурсы.`,
      telemetry: {
        mode, uploadedCount: files.length, passedCount: passed.length,
        dedupedCount: 0, selectedCount: 0, rejectedCount: files.length - passed.length,
        rejectionReasons, selectedIndices: [], latencyMs, hardReject: true,
      },
    };
  }

  // Sort by score descending
  const sorted = [...passed].sort((a, b) => b.score - a.score);

  // Deduplicate
  const deduped: PhotoScore[] = [];
  for (const candidate of sorted) {
    const isDuplicate = deduped.some(existing =>
      areSimilar(files[candidate.index].buffer, files[existing.index].buffer)
    );
    if (isDuplicate) {
      candidate.reasons.push("duplicate_removed");
      warnings.push(`Photo ${candidate.index + 1} (${candidate.filename}) duplicate, skipped`);
    } else {
      deduped.push(candidate);
    }
  }

  // Apply mode-specific selection strategy
  const selected = isFree
    ? selectFreeStrategy(deduped, targetSelection)
    : selectPremiumStrategy(deduped, targetSelection);

  for (const s of selected) {
    s.selected = true;
  }

  if (selected.length < (isFree ? 2 : 5)) {
    warnings.push(`Only ${selected.length} unique quality photo(s) selected. More diverse photos would improve results.`);
  }

  const selectedIndices = selected.map(s => s.index);
  const latencyMs = Date.now() - startMs;

  const telemetry: CurationTelemetry = {
    mode,
    uploadedCount: files.length,
    passedCount: passed.length,
    dedupedCount: deduped.length,
    selectedCount: selected.length,
    rejectedCount: files.length - passed.length,
    rejectionReasons,
    selectedIndices,
    latencyMs,
    hardReject: false,
  };

  // Structured log
  console.log(
    `[InputCuration] mode=${mode} | ${files.length} uploaded → ${passed.length} passed → ${deduped.length} unique → ${selected.length} selected | ${latencyMs}ms`
  );
  for (const s of allScores) {
    console.log(
      `  [${s.index}] ${s.filename}: ${s.width}x${s.height} score=${s.score} pass=${s.passed} sel=${s.selected}${s.reasons.length ? " [" + s.reasons.join(", ") + "]" : ""}`
    );
  }

  return {
    selectedIndices,
    allScores,
    warnings,
    hardReject: false,
    telemetry,
  };
}
