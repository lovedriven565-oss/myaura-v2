/**
 * Database Queue Module — CloudRun-safe replacement for in-memory PQueue
 * 
 * Uses Supabase PostgreSQL tables:
 * - generation_queue: stores pending/processing jobs
 * - user_rate_limits: per-user rate limiting
 * 
 * Survives Cloud Run container restarts and works across multiple instances.
 */

import { getDb } from "./db.js";

export interface QueueItem {
  id: string;
  generationId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  attempts: number;
  maxAttempts: number;
  scheduledAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  workerId?: string;
}

/**
 * Enqueue a new generation job.
 * Called immediately after generation record is created.
 */
export async function enqueueGeneration(
  generationId: string,
  priority: number = 0,
  scheduledAt: Date = new Date()
): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from('generation_queue')
    .insert({
      generation_id: generationId,
      priority,
      scheduled_at: scheduledAt.toISOString(),
      status: 'pending',
      attempts: 0,
      max_attempts: 3
    });
  
  if (error) {
    console.error(`[DbQueue] Failed to enqueue ${generationId}:`, error.message);
    throw new Error(`Failed to enqueue generation: ${error.message}`);
  }
  
  console.log(`[DbQueue] Enqueued ${generationId} with priority ${priority}`);
}

/**
 * Dequeue next pending job using atomic SELECT FOR UPDATE SKIP LOCKED.
 * Returns null if queue is empty.
 */
export async function dequeueNext(workerId: string = 'unknown'): Promise<string | null> {
  const db = getDb();
  
  // Use RPC for atomic dequeue
  const { data, error } = await db.rpc('dequeue_next_generation', {
    p_worker_id: workerId
  });
  
  if (error) {
    console.error('[DbQueue] Dequeue error:', error.message);
    return null;
  }
  
  if (data) {
    console.log(`[DbQueue] Dequeued ${data} for worker ${workerId}`);
  }
  
  return data;
}

/**
 * Mark queue item as completed.
 */
export async function completeGeneration(generationId: string): Promise<void> {
  const db = getDb();
  
  const { error } = await db.rpc('complete_queue_item', {
    p_generation_id: generationId,
    p_success: true,
    p_error_message: null
  });
  
  if (error) {
    console.error(`[DbQueue] Failed to complete ${generationId}:`, error.message);
  } else {
    console.log(`[DbQueue] Completed ${generationId}`);
  }
}

/**
 * Mark queue item as failed.
 */
export async function failGeneration(
  generationId: string,
  errorMessage: string
): Promise<void> {
  const db = getDb();
  
  const { error } = await db.rpc('complete_queue_item', {
    p_generation_id: generationId,
    p_success: false,
    p_error_message: errorMessage
  });
  
  if (error) {
    console.error(`[DbQueue] Failed to mark failed ${generationId}:`, error.message);
  } else {
    console.log(`[DbQueue] Marked failed ${generationId}: ${errorMessage}`);
  }
}

/**
 * Database-backed rate limit check.
 *
 * Returns the number of seconds the caller must wait before retrying. `0`
 * means the request is allowed; any positive number means the user is in
 * cooldown.
 *
 * Robustness contract:
 *   • If the RPC is missing, misimplemented, or returns a non-numeric payload
 *     (e.g. a prior deploy of the SQL function returned BOOLEAN instead of
 *     INT — that bug caused the infamous "retry in trues" log line), we
 *     FAIL OPEN. Rate limiting is a convenience guardrail, not a security
 *     boundary; a malformed RPC must never permanently lock out a user.
 *   • We additionally emit a single warn-line when we see a non-numeric
 *     payload so operators can spot the SQL regression quickly.
 */
export async function checkRateLimit(
  userId: number,
  cooldownSeconds: number = 120
): Promise<number> {
  const db = getDb();

  const { data, error } = await db.rpc('check_rate_limit', {
    p_user_id: userId,
    p_cooldown_seconds: cooldownSeconds,
  });

  if (error) {
    console.error('[DbQueue] Rate limit check error:', error.message);
    return 0; // Fail open
  }

  // The legacy SQL signature returns INT seconds. A broken signature that
  // returns BOOLEAN (`true` = blocked, `false` = allowed) is the exact bug
  // that produced "retry in trues" — `true > 0` is truthy in JS and gets
  // interpolated as the string "true". Coerce defensively.
  if (typeof data === 'number' && Number.isFinite(data)) {
    return Math.max(0, Math.floor(data));
  }

  if (data !== null && data !== undefined) {
    console.warn(
      `[DbQueue] check_rate_limit returned non-numeric payload: ${JSON.stringify(data)} ` +
      `(type=${typeof data}). Failing open. Fix the SQL function to RETURNS INT.`
    );
  }
  return 0; // Fail open on unknown payload
}

/**
 * Roll back the rate-limit timestamp for a user.
 *
 * Why this exists:
 *   `check_rate_limit` is side-effecting — it both reads the cooldown and
 *   stamps `last_generation = now()` in one atomic step. That is fine when
 *   the call leads to a successful generation, but if the request fails
 *   downstream (IAM error, storage error, pre-consumption validation…) the
 *   user is penalised for our outage. `clearRateLimit` undoes that stamp so
 *   the user can retry immediately.
 *
 * Idempotent: safe to call even when no row exists (treated as a no-op).
 * Never throws — rollback failure must not mask the original error.
 */
export async function clearRateLimit(userId: number): Promise<void> {
  try {
    const db = getDb();
    // Reset the window so the user is immediately eligible again. We set
    // last_generation far enough in the past that any reasonable cooldown
    // passes. Using a hard `1970-01-01` avoids pulling a date library here.
    const { error } = await db
      .from('user_rate_limits')
      .update({ last_generation: new Date(0).toISOString() })
      .eq('user_id', userId);

    if (error) {
      console.warn(`[DbQueue] clearRateLimit failed for user=${userId}: ${error.message}`);
    }
  } catch (err: any) {
    console.warn(`[DbQueue] clearRateLimit threw for user=${userId}: ${err?.message || err}`);
  }
}

/**
 * Refund credit to user (idempotent).
 * Returns true if refund was processed.
 */
export async function refundCredit(
  telegramId: number,
  creditType: 'free' | 'paid',
  generationId: string,
  reason: string
): Promise<boolean> {
  const db = getDb();
  
  const { data, error } = await db.rpc('refund_credit', {
    p_telegram_id: telegramId,
    p_type: creditType,
    p_generation_id: generationId,
    p_reason: reason
  });
  
  if (error) {
    console.error(`[DbQueue] Refund failed for ${generationId}:`, error.message);
    return false;
  }
  
  // Also update generation record
  if (data) {
    await db
      .from('generations')
      .update({ credit_refunded: true })
      .eq('id', generationId);
    
    console.log(`[DbQueue] Refunded ${creditType} credit to ${telegramId} for ${generationId}: ${reason}`);
  }
  
  return data || false;
}

/**
 * Record that credit was consumed for this generation.
 */
export async function markCreditConsumed(
  generationId: string,
  creditType: 'free' | 'paid'
): Promise<void> {
  const db = getDb();
  
  const { error } = await db
    .from('generations')
    .update({ 
      credit_type: creditType,
      credit_consumed: true 
    })
    .eq('id', generationId);
  
  if (error) {
    console.error(`[DbQueue] Failed to mark credit consumed ${generationId}:`, error.message);
  }
}

/**
 * Get queue depth for monitoring.
 */
export async function getQueueDepth(): Promise<{ pending: number; processing: number }> {
  const db = getDb();
  
  const { data, error } = await db
    .from('generation_queue')
    .select('status', { count: 'exact' })
    .in('status', ['pending', 'processing']);
  
  if (error || !data) {
    return { pending: 0, processing: 0 };
  }
  
  const pending = data.filter((r: any) => r.status === 'pending').length;
  const processing = data.filter((r: any) => r.status === 'processing').length;
  
  return { pending, processing };
}
