import PQueue from "p-queue";
import { PromptType, StyleId } from "./prompts.js";

// Global governed queue: strictly sequential, min 6s between task starts.
// Prevents Thundering Herd / Token Bucket Exhaustion on Vertex AI.
export const generationQueue = new PQueue({
  concurrency: 1,
  interval: parseInt(process.env.INTER_REQUEST_DELAY_MS || "6000"),
  intervalCap: 1,
});

export type PackageId = "free" | "starter" | "pro" | "max";

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

const FREE_V2 = process.env.FREE_MULTI_REF_V2_ENABLED === "true";

export const PACKAGES: Record<PackageId, PackageConfig> = {
  free: {
    id: "free",
    minRefs: 1,
    maxRefs: FREE_V2 ? 5 : 1,
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
    outputCount: 7,
    maxStyles: 1,
    promptTier: "premium",
    retentionEnvKey: "RETENTION_PREMIUM_REF_MINUTES",
    retentionDefault: 4320,
  },
  pro: {
    id: "pro",
    minRefs: 10,
    maxRefs: 15,
    outputCount: 25,
    maxStyles: 3,
    promptTier: "premium",
    retentionEnvKey: "RETENTION_PREMIUM_REF_MINUTES",
    retentionDefault: 4320,
  },
  max: {
    id: "max",
    minRefs: 10,
    maxRefs: 15,
    outputCount: 60,
    maxStyles: 6,
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
  return buildStyleScheduleWithCount(config, styleIds, config.outputCount);
}

// Same as buildStyleSchedule but with custom count
export function buildStyleScheduleWithCount(config: PackageConfig, styleIds: StyleId[], count: number): StyleId[] {
  const schedule: StyleId[] = [];
  const total = count;
  
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

// Per-package generation config — concurrency is now owned by generationQueue.
// These values are kept for logging/compat only; the queue enforces actual limits.
export function getGenerationConfig(packageId: PackageId): { concurrency: number; delayMs: number } {
  return { concurrency: 1, delayMs: parseInt(process.env.INTER_REQUEST_DELAY_MS || "6000") };
}

// Error isolation wrapper: lets the task throw without crashing the queue.
// 429 / rate-limit retries are handled exclusively in ai.ts withExponentialBackoff
// to avoid conflicting backoff timers and log noise.
async function withRetry<R>(
  fn: () => Promise<R>,
): Promise<R> {
  return fn();
}

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH || "200");

// Governed batch execution via p-queue.
// Tasks run strictly one at a time with a minimum interval between starts.
// No Promise.all — zero Thundering Herd risk.
export async function runBatched<T, R>(
  items: T[],
  task: (item: T, index: number) => Promise<R>,
  options: {
    concurrency: number;  // kept for API compat — queue controls actual concurrency
    delayMs: number;      // kept for API compat — queue interval controls delay
    onItemComplete?: (index: number, result: PromiseSettledResult<R>) => void;
  }
): Promise<PromiseSettledResult<R>[]> {
  const { onItemComplete } = options;
  const results = new Array<PromiseSettledResult<R>>(items.length);

  // Admission control: reject batch if queue is at capacity
  if (generationQueue.size + items.length > MAX_QUEUE_DEPTH) {
    throw Object.assign(
      new Error(`Generation queue at capacity (depth=${generationQueue.size}). Please try again in a few minutes.`),
      { code: "QUEUE_FULL", status: 429 }
    );
  }

  // Enqueue all tasks at once — queue governs when each one starts
  const taskPromises = items.map((item, i) =>
    generationQueue.add(async () => {
      console.log(`[Queue] Task ${i + 1}/${items.length} starting | queued: ${generationQueue.size} | running: ${generationQueue.pending}`);
      let result: PromiseSettledResult<R>;
      try {
        const value = await withRetry(() => task(item, i));
        result = { status: "fulfilled", value };
        console.log(`[Queue] Task ${i + 1}/${items.length} SUCCESS ✓`);
      } catch (reason: any) {
        result = { status: "rejected", reason };
        console.error(`[Queue] Task ${i + 1}/${items.length} FAILED ✗ | error: ${reason?.message || String(reason)}`);
        console.error(`[Queue] Task ${i + 1}/${items.length} stack:`, reason?.stack || "no stack");
      }
      results[i] = result;
      console.log(`[Queue] Task ${i + 1}/${items.length} DONE | status=${result.status} | queue size now: ${generationQueue.size}`);
      try {
        if (onItemComplete) onItemComplete(i, result);
      } catch (cbErr: any) {
        console.error(`[Queue] Task ${i + 1}/${items.length} onItemComplete THREW:`, cbErr?.message, cbErr?.stack);
      }
    })
  );

  await Promise.all(taskPromises);
  return results;
}
