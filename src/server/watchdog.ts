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
  });
}
