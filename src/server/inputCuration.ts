/**
 * Input Curation Module for Premium Reference Photos
 * 
 * Pragmatic heuristics-based approach using image metadata and buffer analysis.
 * No external ML dependencies — works with what we have.
 */

export interface PhotoScore {
  index: number;
  filename: string;
  sizeBytes: number;
  score: number;
  passed: boolean;
  selected: boolean;
  reasons: string[];
}

export interface CurationResult {
  selectedIndices: number[];
  allScores: PhotoScore[];
  warnings: string[];
  hardReject: boolean;
  hardRejectReason?: string;
}

// Thresholds (configurable via env)
const MIN_FILE_SIZE = parseInt(process.env.CURATION_MIN_FILE_SIZE || "30000"); // 30KB — extremely small photos are usually thumbnails or corrupted
const MAX_FILE_SIZE = parseInt(process.env.CURATION_MAX_FILE_SIZE || "10485760"); // 10MB
const MIN_DIMENSION = 256; // pixels — below this the face is too small to be useful
const TARGET_SELECTION = parseInt(process.env.CURATION_TARGET_SELECTION || "8"); // select best N
const MIN_ACCEPTABLE = parseInt(process.env.CURATION_MIN_ACCEPTABLE || "3"); // hard reject below this
const DUPLICATE_THRESHOLD = 0.97; // similarity threshold for duplicate detection

/**
 * Analyze a single photo buffer and return quality metrics.
 * Uses lightweight heuristics — no ML models.
 */
function analyzePhoto(buffer: Buffer, filename: string, index: number): PhotoScore {
  const reasons: string[] = [];
  let score = 50; // start at neutral

  const sizeBytes = buffer.length;

  // 1. File size scoring
  if (sizeBytes < MIN_FILE_SIZE) {
    reasons.push(`too_small: ${Math.round(sizeBytes / 1024)}KB < ${Math.round(MIN_FILE_SIZE / 1024)}KB minimum`);
    score -= 40;
  } else if (sizeBytes < 100_000) {
    reasons.push("low_resolution_likely");
    score -= 15;
  } else if (sizeBytes > 500_000) {
    // Larger files typically = higher resolution = more facial detail
    score += 10;
  }
  if (sizeBytes > 2_000_000) {
    score += 5; // bonus for very high-res
  }
  if (sizeBytes > MAX_FILE_SIZE) {
    reasons.push(`too_large: ${Math.round(sizeBytes / 1048576)}MB`);
    score -= 10;
  }

  // 2. JPEG quality estimation via buffer entropy
  // Higher entropy in JPEG data generally means more detail (less compression)
  const entropy = estimateEntropy(buffer.slice(0, Math.min(buffer.length, 8192)));
  if (entropy < 4.0) {
    reasons.push("low_entropy: likely heavy compression or very uniform image");
    score -= 20;
  } else if (entropy > 6.5) {
    score += 10; // good detail
  }

  // 3. Brightness estimation (sample pixel data from raw buffer)
  const brightness = estimateBrightness(buffer);
  if (brightness < 40) {
    reasons.push(`too_dark: brightness=${brightness}`);
    score -= 25;
  } else if (brightness > 240) {
    reasons.push(`overexposed: brightness=${brightness}`);
    score -= 25;
  } else if (brightness >= 80 && brightness <= 200) {
    score += 10; // good exposure
  }

  // 4. Variance estimation (proxy for blur detection)
  // Very low variance = flat/blurry image
  const variance = estimateVariance(buffer);
  if (variance < 15) {
    reasons.push(`likely_blurry: variance=${variance.toFixed(1)}`);
    score -= 20;
  } else if (variance > 40) {
    score += 10; // good sharpness
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));
  const passed = score >= 30;

  return {
    index,
    filename,
    sizeBytes,
    score,
    passed,
    selected: false, // will be set later
    reasons,
  };
}

/**
 * Shannon entropy estimation on a buffer sample.
 * Higher = more information/detail. Lower = more uniform/compressed.
 */
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

/**
 * Estimate average brightness from raw buffer bytes.
 * Samples evenly across the buffer to get a rough average.
 */
function estimateBrightness(buffer: Buffer): number {
  // Skip headers (first ~2KB for JPEG), sample from middle of file
  const start = Math.min(2048, Math.floor(buffer.length * 0.2));
  const end = Math.min(buffer.length, start + 4096);
  if (end <= start) return 128; // can't estimate

  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += buffer[i];
    count++;
  }
  return count > 0 ? Math.round(sum / count) : 128;
}

/**
 * Estimate variance (contrast/sharpness proxy) from buffer bytes.
 * Low variance = flat/blurry. High variance = sharp/detailed.
 */
function estimateVariance(buffer: Buffer): number {
  const start = Math.min(2048, Math.floor(buffer.length * 0.2));
  const end = Math.min(buffer.length, start + 4096);
  if (end <= start) return 50;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    sum += buffer[i];
    sumSq += buffer[i] * buffer[i];
    count++;
  }
  const mean = sum / count;
  const variance = (sumSq / count) - (mean * mean);
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Detect near-duplicate photos by comparing buffer fingerprints.
 * Uses a simple approach: compare file sizes and sampled byte patterns.
 */
function areSimilar(a: Buffer, b: Buffer): boolean {
  // If sizes are very close (within 5%), check deeper
  const sizeRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (sizeRatio < 0.9) return false; // Different sizes = different photos

  // Compare sampled regions
  const sampleSize = 512;
  const offsetA = Math.min(2048, Math.floor(a.length * 0.3));
  const offsetB = Math.min(2048, Math.floor(b.length * 0.3));
  
  if (offsetA + sampleSize > a.length || offsetB + sampleSize > b.length) return false;

  let matches = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (Math.abs(a[offsetA + i] - b[offsetB + i]) < 8) {
      matches++;
    }
  }
  
  return (matches / sampleSize) > DUPLICATE_THRESHOLD;
}

/**
 * Main curation function.
 * Selects the best reference photos from user uploads.
 */
export function selectBestReferencePhotos(
  files: { buffer: Buffer; originalname: string }[]
): CurationResult {
  const warnings: string[] = [];

  // Score all photos
  const allScores = files.map((file, idx) => analyzePhoto(file.buffer, file.originalname, idx));

  // Filter out failed photos
  const passed = allScores.filter(s => s.passed);

  if (passed.length < MIN_ACCEPTABLE) {
    return {
      selectedIndices: [],
      allScores,
      warnings: [
        `Only ${passed.length} photos passed quality check (minimum ${MIN_ACCEPTABLE}).`,
        "Tips: Use good lighting, show face clearly, avoid filters, use different angles, avoid group photos."
      ],
      hardReject: true,
      hardRejectReason: `Недостаточно качественных фото. Прошло проверку: ${passed.length} из ${files.length}. Рекомендации: хорошее освещение, лицо крупным планом, без фильтров, разные ракурсы.`,
    };
  }

  // Sort by score descending
  const sorted = [...passed].sort((a, b) => b.score - a.score);

  // Deduplicate: remove near-identical photos
  const deduped: PhotoScore[] = [];
  for (const candidate of sorted) {
    const isDuplicate = deduped.some(existing => 
      areSimilar(files[candidate.index].buffer, files[existing.index].buffer)
    );
    if (isDuplicate) {
      candidate.reasons.push("duplicate_removed");
      warnings.push(`Photo ${candidate.index + 1} (${candidate.filename}) looks like a duplicate, skipped`);
    } else {
      deduped.push(candidate);
    }
  }

  // Select top N
  const targetCount = Math.min(TARGET_SELECTION, deduped.length);
  const selected = deduped.slice(0, targetCount);

  // Mark selected
  for (const s of selected) {
    s.selected = true;
  }

  // Warnings for marginal cases
  if (selected.length < 5) {
    warnings.push(`Only ${selected.length} unique quality photos selected. More diverse photos would improve results.`);
  }

  const selectedIndices = selected.map(s => s.index);

  console.log(`[InputCuration] ${files.length} files → ${passed.length} passed → ${deduped.length} unique → ${selected.length} selected`);
  for (const s of allScores) {
    console.log(`  [${s.index}] ${s.filename}: score=${s.score}, passed=${s.passed}, selected=${s.selected}${s.reasons.length ? ' reasons=[' + s.reasons.join(', ') + ']' : ''}`);
  }

  return {
    selectedIndices,
    allScores,
    warnings,
    hardReject: false,
  };
}
