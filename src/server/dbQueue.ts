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
 * Returns seconds to wait (0 if allowed).
 */
export async function checkRateLimit(
  userId: number,
  cooldownSeconds: number = 120
): Promise<number> {
  const db = getDb();
  
  const { data, error } = await db.rpc('check_rate_limit', {
    p_user_id: userId,
    p_cooldown_seconds: cooldownSeconds
  });
  
  if (error) {
    console.error('[DbQueue] Rate limit check error:', error.message);
    // Fail open: allow if we can't check
    return 0;
  }
  
  return data || 0;
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
