import { PromptType, StyleId } from "./prompts.js";

export type PackageId = "free" | "starter" | "signature" | "premium";

export interface PackageConfig {
  id: PackageId;
  minRefs: number;
  maxRefs: number;
  outputCount: number;
  maxStyles: number;
  promptTier: PromptType;
  retentionEnvKey: string;
  retentionDefault: number;
}

export const PACKAGES: Record<PackageId, PackageConfig> = {
  free: {
    id: "free",
    minRefs: 1,
    maxRefs: 1,
    outputCount: 1,
    maxStyles: 1,
    promptTier: "free",
    retentionEnvKey: "RETENTION_ORIGINAL_MINUTES",
    retentionDefault: 1440, // 24 hours
  },
  starter: {
    id: "starter",
    minRefs: 10,
    maxRefs: 15,
    outputCount: 5,
    maxStyles: 1,
    promptTier: "premium",
    retentionEnvKey: "RETENTION_PREMIUM_REF_MINUTES",
    retentionDefault: 4320, // 3 days
  },
  signature: {
    id: "signature",
    minRefs: 10,
    maxRefs: 15,
    outputCount: 10,
    maxStyles: 3,
    promptTier: "premium",
    retentionEnvKey: "RETENTION_PREMIUM_REF_MINUTES",
    retentionDefault: 4320,
  },
  premium: {
    id: "premium",
    minRefs: 10,
    maxRefs: 15,
    outputCount: 15,
    maxStyles: 6, // Or whatever the total available styles is
    promptTier: "premium",
    retentionEnvKey: "RETENTION_PREMIUM_REF_MINUTES",
    retentionDefault: 4320,
  },
};

export function validatePackageInput(
  packageId: string,
  fileCount: number,
  styleIds: string[]
): { ok: boolean; error?: string; code?: string; config?: PackageConfig } {
  const config = PACKAGES[packageId as PackageId];
  if (!config) {
    return { ok: false, error: "Invalid package ID", code: "INVALID_PACKAGE" };
  }

  if (fileCount < config.minRefs || fileCount > config.maxRefs) {
    return {
      ok: false,
      error: `Package '${packageId}' requires between ${config.minRefs} and ${config.maxRefs} reference images. You provided ${fileCount}.`,
      code: "INVALID_IMAGE_COUNT",
    };
  }

  if (!styleIds || styleIds.length === 0) {
    return { ok: false, error: "At least one style must be selected", code: "MISSING_STYLES" };
  }

  if (styleIds.length > config.maxStyles) {
    return {
      ok: false,
      error: `Package '${packageId}' allows a maximum of ${config.maxStyles} styles. You provided ${styleIds.length}.`,
      code: "TOO_MANY_STYLES",
    };
  }

  return { ok: true, config };
}

// Distributes requested styles evenly across the output count
export function buildStyleSchedule(config: PackageConfig, styleIds: StyleId[]): StyleId[] {
  const schedule: StyleId[] = [];
  const total = config.outputCount;
  
  // If no styles provided (fallback), just use business
  if (!styleIds || styleIds.length === 0) {
    for (let i = 0; i < total; i++) schedule.push("business");
    return schedule;
  }

  // Round-robin distribution
  for (let i = 0; i < total; i++) {
    schedule.push(styleIds[i % styleIds.length]);
  }
  
  return schedule;
}

// Per-package generation config from environment
export function getGenerationConfig(packageId: PackageId): { concurrency: number; delayMs: number } {
  const isFree = packageId === "free";
  return {
    concurrency: isFree ? 1 : parseInt(process.env.PREMIUM_CONCURRENCY || "3"),
    delayMs: isFree ? 10_000 : parseInt(process.env.INTER_REQUEST_DELAY_MS || "5000"),
  };
}

// Retry wrapper with exponential backoff for 429 rate limit errors
async function withRetry<R>(
  fn: () => Promise<R>,
  maxRetries: number = 3,
  baseDelayMs: number = 20_000
): Promise<R> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const is429 = error?.status === 429 ||
                    error?.message?.includes("429") ||
                    error?.message?.includes("RESOURCE_EXHAUSTED");

      if (is429 && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 20s, 40s, 80s
        console.warn(`Rate limited (429), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (is429) {
        throw new Error("Google Cloud Quota reached. Please wait a few minutes.");
      }
      throw error;
    }
  }
  throw new Error("withRetry: unreachable");
}

// Batch execution with configurable concurrency, inter-batch delay, and per-item callback
export async function runBatched<T, R>(
  items: T[],
  task: (item: T, index: number) => Promise<R>,
  options: {
    concurrency: number;
    delayMs: number;
    onItemComplete?: (index: number, result: PromiseSettledResult<R>) => void;
  }
): Promise<PromiseSettledResult<R>[]> {
  const { concurrency, delayMs, onItemComplete } = options;
  const results: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    // Inter-batch delay (not before the first batch)
    if (i > 0) {
      console.log(`Throttle: waiting ${delayMs / 1000}s before batch starting at ${i + 1}/${items.length}`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    const batch = items.slice(i, i + concurrency);
    const batchPromises = batch.map(async (item, batchIdx) => {
      const globalIdx = i + batchIdx;
      let result: PromiseSettledResult<R>;
      try {
        const value = await withRetry(() => task(item, globalIdx));
        result = { status: "fulfilled", value };
      } catch (reason: any) {
        result = { status: "rejected", reason };
      }
      if (onItemComplete) onItemComplete(globalIdx, result);
      return result;
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}
