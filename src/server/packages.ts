// ═════════════════════════════════════════════════════════════════════════════
// MyAURA V6.0 — Package Catalogue & Generation Queue
// ═════════════════════════════════════════════════════════════════════════════
//
// Enforces strict tier constraints:
//   FREE     : 1-5 refs in  → 1 output
//   STARTER  : 10-15 refs in → 7 outputs
//   PRO      : 10-15 refs in → 25 outputs  (max 3 styles)
//   MAX      : 10-15 refs in → 60 outputs  (max 6 styles)
//
// The PREMIUM tiers all share the same ref window (10-15). Output counts are
// tied to the paid package.
// ═════════════════════════════════════════════════════════════════════════════

import PQueue from "p-queue";
import { PromptType, StyleId } from "./prompts.js";

// Governed queue: single concurrency + minimum inter-request spacing protects
// the upstream Vertex AI quota from thundering-herd bursts.
export const generationQueue = new PQueue({
  concurrency: parseInt(process.env.GENERATION_QUEUE_CONCURRENCY || "1", 10),
  interval:    parseInt(process.env.INTER_REQUEST_DELAY_MS       || "6000", 10),
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

export const PACKAGES: Record<PackageId, PackageConfig> = {
  free: {
    id: "free",
    minRefs: 1,
    maxRefs: 5,
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
  styleIds: string[],
): { ok: boolean; error?: string; code?: string; config?: PackageConfig } {
  const config = PACKAGES[packageId as PackageId];
  if (!config) {
    return { ok: false, error: "Invalid package ID", code: "INVALID_PACKAGE" };
  }

  if (fileCount < config.minRefs || fileCount > config.maxRefs) {
    return {
      ok: false,
      error:
        `Package '${packageId}' requires between ${config.minRefs} and ` +
        `${config.maxRefs} reference images. You provided ${fileCount}.`,
      code: "INVALID_IMAGE_COUNT",
    };
  }

  if (!styleIds || styleIds.length === 0) {
    return { ok: false, error: "At least one style must be selected", code: "MISSING_STYLES" };
  }

  if (styleIds.length > config.maxStyles) {
    return {
      ok: false,
      error:
        `Package '${packageId}' allows a maximum of ${config.maxStyles} styles. ` +
        `You provided ${styleIds.length}.`,
      code: "TOO_MANY_STYLES",
    };
  }

  return { ok: true, config };
}

/** Distribute requested styles evenly across the output count (round-robin). */
export function buildStyleSchedule(config: PackageConfig, styleIds: StyleId[]): StyleId[] {
  return buildStyleScheduleWithCount(config, styleIds, config.outputCount);
}

export function buildStyleScheduleWithCount(
  _config: PackageConfig,
  styleIds: StyleId[],
  count: number,
): StyleId[] {
  const schedule: StyleId[] = [];

  if (!styleIds || styleIds.length === 0) {
    for (let i = 0; i < count; i++) schedule.push("business");
    return schedule;
  }

  for (let i = 0; i < count; i++) {
    schedule.push(styleIds[i % styleIds.length]);
  }
  return schedule;
}

/**
 * Queue configuration snapshot. Actual concurrency / delay is enforced by
 * `generationQueue` — these values are kept for logging compatibility.
 */
export function getGenerationConfig(_packageId: PackageId): { concurrency: number; delayMs: number } {
  return {
    concurrency: parseInt(process.env.GENERATION_QUEUE_CONCURRENCY || "1", 10),
    delayMs:     parseInt(process.env.INTER_REQUEST_DELAY_MS       || "6000", 10),
  };
}

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH || "200", 10);

/**
 * Governed batch execution via p-queue. All tasks respect the global
 * concurrency + inter-request interval — no Promise.all thundering-herd.
 */
export async function runBatched<T, R>(
  items: T[],
  task: (item: T, index: number) => Promise<R>,
  options: {
    concurrency: number; // kept for API compat — ignored in favour of the queue
    delayMs: number;     // kept for API compat — ignored in favour of the queue
    onItemComplete?: (index: number, result: PromiseSettledResult<R>) => void;
  },
): Promise<PromiseSettledResult<R>[]> {
  const { onItemComplete } = options;
  const results = new Array<PromiseSettledResult<R>>(items.length);

  // Admission control: reject batch if queue is already at capacity.
  if (generationQueue.size + items.length > MAX_QUEUE_DEPTH) {
    throw Object.assign(
      new Error(
        `Generation queue at capacity (depth=${generationQueue.size}). Please retry in a few minutes.`,
      ),
      { code: "QUEUE_FULL", status: 429 },
    );
  }

  const taskPromises = items.map((item, i) =>
    generationQueue.add(async () => {
      let result: PromiseSettledResult<R>;
      try {
        const value = await task(item, i);
        result = { status: "fulfilled", value };
      } catch (reason: any) {
        result = { status: "rejected", reason };
        console.error(`[Queue] Task ${i + 1}/${items.length} FAILED: ${reason?.message || reason}`);
      }
      results[i] = result;
      try {
        onItemComplete?.(i, result);
      } catch (cbErr: any) {
        console.error(`[Queue] onItemComplete threw for task ${i + 1}: ${cbErr?.message || cbErr}`);
      }
    }),
  );

  await Promise.all(taskPromises);
  return results;
}
