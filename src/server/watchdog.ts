/**
 * Generation Watchdog — fail-safe for orphaned / zombie generations.
 *
 * Why it exists:
 *   Cloud Run is an ephemeral environment. If a container is recycled while a
 *   background generation is in flight, the row in `generations` stays in
 *   status='processing' forever. The user's client polls /api/status/:id and
 *   sees an infinite spinner. Worse, their credit is already spent.
 *
 * What it does:
 *   Every WATCHDOG_INTERVAL_SECONDS, it calls the `reclaim_orphaned_generations`
 *   RPC which atomically marks any generation stuck longer than
 *   WATCHDOG_STALE_SECONDS as 'failed' and returns the rows. For each reclaimed
 *   row we issue an idempotent refund through the existing `refund_credit` RPC
 *   (safe to call multiple times across restarts — it is keyed by generation_id).
 *
 * Safe across multiple Cloud Run instances: the SQL uses `FOR UPDATE SKIP LOCKED`
 * so two instances cannot double-process the same zombie.
 */

import cron from "node-cron";
import { getDb } from "./db.js";
import { refundCredit } from "./dbQueue.js";
import { aiProvider } from "./ai.js";
import { buildV9TunedPrompt } from "./prompts.js";
import type { StyleId } from "./prompts.js";
import { getGenerationConfig, buildStyleScheduleWithCount, runBatched } from "./packages.js";
import { deliverTelegramPhoto, deliverTelegramResults, sendTelegramStatus } from "./telegram.js";
import { storage } from "./storage.js";
import { deleteTuningDataset } from "./gcs.js";

const WATCHDOG_INTERVAL_SECONDS = parseInt(process.env.WATCHDOG_INTERVAL_SECONDS || "60");
const WATCHDOG_STALE_SECONDS = parseInt(process.env.WATCHDOG_STALE_SECONDS || "600"); // 10 min

export interface OrphanedGeneration {
  generation_id: string;
  telegram_user_id: number | null;
  credit_type: "free" | "paid" | null;
  created_at: string;
}

/**
 * One tick of the watchdog. Exported for unit tests and one-off manual runs.
 * Returns the number of zombies reclaimed this tick.
 */
export async function runWatchdogTick(): Promise<number> {
  const db = getDb();

  const { data, error } = await db.rpc("reclaim_orphaned_generations", {
    p_stale_seconds: WATCHDOG_STALE_SECONDS,
  });

  if (error) {
    console.error("[Watchdog] reclaim_orphaned_generations RPC error:", error.message);
    return 0;
  }

  const rows = (data || []) as OrphanedGeneration[];
  if (rows.length === 0) return 0;

  console.warn(`[Watchdog] Reclaimed ${rows.length} orphaned generation(s)`);

  // Issue refunds sequentially — order does not matter and we'd rather be gentle
  // on Supabase than flood it with parallel RPC calls.
  for (const row of rows) {
    const { generation_id, telegram_user_id, credit_type } = row;
    const age = Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000);

    console.warn(
      `[Watchdog] Zombie reclaimed: id=${generation_id} userId=${telegram_user_id} ` +
      `creditType=${credit_type} ageSec=${age}`
    );

    if (telegram_user_id && credit_type) {
      try {
        const refunded = await refundCredit(
          telegram_user_id,
          credit_type,
          generation_id,
          `Watchdog: generation orphaned after ${age}s with no heartbeat`
        );
        if (refunded) {
          console.warn(`[Watchdog] Refunded ${credit_type} credit to user=${telegram_user_id} (gen=${generation_id})`);
        } else {
          console.log(`[Watchdog] Refund already recorded for gen=${generation_id} (idempotent skip)`);
        }
      } catch (refundErr: any) {
        console.error(`[Watchdog] Refund RPC threw for gen=${generation_id}:`, refundErr?.message || refundErr);
      }
    } else {
      console.warn(`[Watchdog] Cannot refund gen=${generation_id} — missing userId or creditType`);
    }
  }

  return rows.length;
}

/**
 * V9.0 Tuning Job Polling and Inference Engine
 * Polls the database for generations stuck in 'pending' or 'running' tuning_status.
 */
async function pollTuningJobs(): Promise<void> {
  const db = getDb();
  const label = "Watchdog.TuningJobs";

  // Atomically claim jobs that need polling (similar to orphaned generations)
  // We use a custom RPC or direct query. For simplicity, we query 'pending' or 'running'
  // but skip those we updated very recently.
  const { data: jobs, error } = await db
    .from("generations")
    .select("id, tuning_job_id, tuning_status, telegram_user_id, package_id, style_ids, results_total, credit_type")
    .in("tuning_status", ["pending", "running"])
    .order("updated_at", { ascending: true })
    .limit(5);

  if (error) {
    console.error(`[${label}] Error fetching tuning jobs:`, error.message);
    return;
  }

  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    try {
      if (!job.tuning_job_id) continue;

      const { status, tunedModelName, error: apiError } = await aiProvider.checkTuningJobStatus(job.tuning_job_id);
      console.log(`[${label}] Job ${job.tuning_job_id} for generation ${job.id}: status=${status}`);

      if (status === "succeeded" && tunedModelName) {
        // Step 1: Mark job as succeeded in DB
        await db.from("generations").update({
          tuning_status: "succeeded",
          tuned_model_resource_name: tunedModelName,
          status: "processing" // Back to processing for inference
        }).eq("id", job.id);

        // Step 2: Trigger Inference asynchronously
        // We don't await this so the watchdog loop doesn't stall
        runTunedInference(job, tunedModelName).catch(err => {
          console.error(`[${label}] Inference failed for job ${job.id}:`, err);
        });

      } else if (status === "failed") {
        console.error(`[${label}] Job ${job.id} failed: ${apiError}`);
        
        await db.from("generations").update({
          tuning_status: "failed",
          status: "failed",
          error_message: `Vertex AI Tuning failed: ${apiError}`
        }).eq("id", job.id);

        // Refund credit
        if (job.telegram_user_id && job.credit_type) {
          await refundCredit(job.telegram_user_id, job.credit_type, job.id, "Tuning Job Failed");
        }

        if (job.telegram_user_id) {
          sendTelegramStatus(job.telegram_user_id, "❌ Произошла ошибка при обучении нейросети. Средства возвращены на ваш баланс.").catch(() => {});
        }

        // Cleanup GCS
        await deleteTuningDataset(job.id);
      } else {
        // running/pending - bump updated_at to push it to the back of the queue
        await db.from("generations").update({ updated_at: new Date().toISOString() }).eq("id", job.id);
      }
    } catch (err: any) {
      console.error(`[${label}] Error polling job ${job.id}:`, err);
    }
  }
}

/**
 * Runs the V9.0 Inference pipeline using the newly trained Vertex AI Model.
 */
async function runTunedInference(job: any, tunedModelName: string): Promise<void> {
  const { id, package_id, style_ids, results_total, telegram_user_id } = job;
  const label = `Inference-${id}`;
  const db = getDb();
  console.log(`[${label}] Starting inference with model: ${tunedModelName}`);

  if (telegram_user_id) {
    sendTelegramStatus(telegram_user_id, "✨ Ваша нейросеть готова! Начинаем генерацию премиальных фотографий...").catch(() => {});
  }

  const VALID_STYLES: StyleId[] = ["business", "lifestyle", "aura", "cinematic", "luxury", "editorial", "cyberpunk", "corporate", "ethereal"];
  
  // Note: We don't have access to the original profile config in the DB row directly,
  // but V9 tuned prompt doesn't need biometric threading.
  const profile = null; 

  const generateOne = async (styleId: StyleId, index: number): Promise<string> => {
    const validStyleId: StyleId = (styleId && VALID_STYLES.includes(styleId)) ? styleId : "business";
    const prompt = buildV9TunedPrompt(validStyleId, index, profile);

    console.log(`[${label}] Image ${index}: style=${validStyleId}`);
    
    const resultBase64 = await aiProvider.generateFromTunedModel(tunedModelName, prompt);
    const resultBuffer = Buffer.from(resultBase64, "base64");
    return await storage.save(resultBuffer, `${id}_result_${index}.jpg`, "result");
  };

  const config = { id: package_id }; // Mock minimal config for schedule builder
  const schedule = buildStyleScheduleWithCount(config as any, style_ids as StyleId[], results_total);
  const genConfig = getGenerationConfig(package_id);

  let completedCount = 0;
  let failedCount = 0;
  const successPaths: string[] = [];
  const errors: string[] = [];
  let dbUpdateChain = Promise.resolve();

  const onItemComplete = (index: number, result: PromiseSettledResult<string>) => {
    if (result.status === "fulfilled") {
      completedCount++;
      successPaths.push(result.value);
      console.log(`[${label}] Image ${index + 1}/${schedule.length} completed`);
      
      if (telegram_user_id) {
        deliverTelegramPhoto(telegram_user_id, result.value).catch(err => 
          console.error(`[${label}] Progressive delivery failed for image ${index + 1}: ${err.message}`)
        );
      }
    } else {
      failedCount++;
      const errMsg = result.reason?.message || String(result.reason);
      errors.push(errMsg);
      console.error(`[${label}] Image ${index + 1} failed: ${errMsg}`);
    }

    dbUpdateChain = dbUpdateChain.then(() =>
      db.from("generations").update({
        results_completed: completedCount,
        results_failed: failedCount,
        result_path: successPaths[0] || null,
        result_paths: [...successPaths],
        last_heartbeat_at: new Date().toISOString(),
      }).eq("id", id).then(() => {})
    ).catch(() => {});
  };

  await runBatched(schedule, generateOne, {
    concurrency: genConfig.concurrency,
    delayMs: genConfig.delayMs,
    onItemComplete,
  });

  await dbUpdateChain;

  const finalStatus = completedCount === 0 ? "failed" : (completedCount < schedule.length ? "partial" : "completed");
  
  await db.from("generations").update({
    status: finalStatus,
    error_message: finalStatus === "failed" ? errors.join(" | ").substring(0, 1000) : null,
  }).eq("id", id);

  console.log(`[${label}] Done: status=${finalStatus}, completed=${completedCount}, failed=${failedCount}`);

  // Final delivery summary
  if (telegram_user_id && completedCount > 0) {
    sendTelegramStatus(telegram_user_id, "🎉 Ваша премиум-генерация завершена! Все фото доставлены.").catch(() => {});
  }

  // Garbage Collection (Tear-down)
  console.log(`[${label}] Starting Garbage Collection...`);
  await aiProvider.deleteTunedModel(tunedModelName);
  await deleteTuningDataset(id);
  console.log(`[${label}] Garbage Collection complete.`);
}

/**
 * Heartbeat helper — called by the generation pipeline after each image
 * finishes (success or fail). Swallows errors: a transient heartbeat failure
 * must not kill the in-progress generation.
 */
export async function updateGenerationHeartbeat(generationId: string): Promise<void> {
  try {
    const db = getDb();
    const { error } = await db.rpc("update_generation_heartbeat", {
      p_generation_id: generationId,
    });
    if (error) {
      console.warn(`[Watchdog] heartbeat RPC error for ${generationId}:`, error.message);
    }
  } catch (err: any) {
    console.warn(`[Watchdog] heartbeat threw for ${generationId}:`, err?.message || err);
  }
}

/**
 * Start the watchdog cron. Called once from server.ts on boot.
 */
export function startWatchdogCron(): void {
  // Build a cron expression from the configured interval. node-cron accepts
  // "*/N * * * * *" for every-N-seconds at six-field precision.
  const cronExpr = `*/${Math.max(10, WATCHDOG_INTERVAL_SECONDS)} * * * * *`;

  console.log(
    `[Watchdog] Starting: tickEverySec=${WATCHDOG_INTERVAL_SECONDS} staleThresholdSec=${WATCHDOG_STALE_SECONDS}`
  );

  cron.schedule(cronExpr, async () => {
    try {
      await runWatchdogTick();
    } catch (err: any) {
      console.error("[Watchdog] Tick threw:", err?.message || err);
    }
    
    // V9.0 Tuning Job Polling
    try {
      await pollTuningJobs();
    } catch (err: any) {
      console.error("[Watchdog] Tuning Polling threw:", err?.message || err);
    }
  });
}
