-- ─── Phase 1: Watchdog + Heartbeat Migration ────────────────────────────────
-- Run in Supabase SQL editor AFTER safe_credits_and_queue.sql.
--
-- Purpose:
--   1. Add last_heartbeat_at column to `generations` for liveness tracking.
--   2. Provide an atomic RPC to reclaim orphaned (zombie) generations —
--      those stuck in status='processing' with no recent heartbeat.
--   3. Provide an atomic RPC that reserves a credit AND inserts the generation
--      record in a single transaction, so partial states are impossible.
--
-- Safe to run multiple times (idempotent).

-- 1. Heartbeat column ─────────────────────────────────────────────────────────
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Index supports the watchdog's hot query: "processing rows with stale heartbeat"
CREATE INDEX IF NOT EXISTS idx_generations_processing_heartbeat
  ON generations (last_heartbeat_at)
  WHERE status = 'processing';

COMMENT ON COLUMN generations.last_heartbeat_at IS
  'Updated by the generation pipeline after each successful AI call. '
  'Used by watchdog cron to detect zombie generations.';


-- 2. RPC: update_generation_heartbeat ─────────────────────────────────────────
-- Called by the pipeline after each completed image so watchdog does not
-- mistake a long-running batch for a zombie.
CREATE OR REPLACE FUNCTION update_generation_heartbeat(
  p_generation_id UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE generations
  SET last_heartbeat_at = now()
  WHERE id = p_generation_id
    AND status = 'processing';
END;
$$;


-- 3. RPC: reclaim_orphaned_generations ───────────────────────────────────────
-- Atomically finds generations that are stuck:
--   status = 'processing' AND last_heartbeat_at < now() - threshold
-- Marks them as 'failed' with a timeout reason and returns the list of
-- (generation_id, telegram_user_id, credit_type) tuples so the caller can
-- trigger refunds through the existing refund_credit RPC.
--
-- Uses FOR UPDATE SKIP LOCKED so concurrent watchdog workers (multiple Cloud Run
-- instances) do not double-process the same row.
CREATE OR REPLACE FUNCTION reclaim_orphaned_generations(
  p_stale_seconds INT DEFAULT 600  -- 10 minutes
) RETURNS TABLE (
  generation_id     UUID,
  telegram_user_id  BIGINT,
  credit_type       TEXT,
  created_at        TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH stale AS (
    SELECT g.id
    FROM generations g
    WHERE g.status = 'processing'
      AND g.last_heartbeat_at < now() - make_interval(secs => p_stale_seconds)
    ORDER BY g.last_heartbeat_at ASC
    LIMIT 50  -- safety: process at most 50 zombies per tick
    FOR UPDATE SKIP LOCKED
  )
  UPDATE generations g
  SET status        = 'failed',
      error_message = COALESCE(g.error_message, 'Orphaned generation reclaimed by watchdog (no heartbeat).'),
      updated_at    = now()
  FROM stale
  WHERE g.id = stale.id
  RETURNING
    g.id,
    g.telegram_user_id,
    g.credit_type,
    g.created_at;
END;
$$;

COMMENT ON FUNCTION reclaim_orphaned_generations IS
  'Atomically marks zombie generations (stale heartbeat) as failed. '
  'Returns the rows so the watchdog can issue refunds.';


-- 4. RPC: reserve_credit_and_create_generation ───────────────────────────────
-- Atomic: checks credit availability, decrements credit, inserts the generation
-- record, and inserts a pending credit_refunds audit row — all in one
-- transaction. Prevents the "credit consumed but no generation record" and
-- "generation record but no credit consumed" partial-failure states.
--
-- Returns NULL if the user has insufficient credits of the requested type.
CREATE OR REPLACE FUNCTION reserve_credit_and_create_generation(
  p_generation_id     UUID,
  p_telegram_id       BIGINT,
  p_mode              TEXT,          -- 'preview' or 'premium'
  p_package_id        TEXT,
  p_type              TEXT,          -- 'free' or 'paid' (target credit bucket)
  p_results_total     INT,
  p_reference_paths   TEXT[],
  p_style_ids         TEXT[],
  p_telegram_chat_id  BIGINT,
  p_expires_at        TIMESTAMPTZ,
  p_prompt_tier       TEXT
) RETURNS TEXT  -- returns 'free' / 'paid' on success, NULL on insufficient funds
LANGUAGE plpgsql
AS $$
DECLARE
  v_user        RECORD;
  v_actual_type TEXT;
BEGIN
  -- Lock the user row to prevent concurrent spend
  SELECT free_credits, paid_credits INTO v_user
  FROM users
  WHERE telegram_id = p_telegram_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;  -- user not found
  END IF;

  -- Determine which credit bucket to debit based on mode + availability
  IF p_mode = 'premium' THEN
    IF v_user.paid_credits > 0 THEN
      v_actual_type := 'paid';
    ELSE
      RETURN NULL;  -- premium requires paid credits
    END IF;
  ELSE
    -- preview mode: free first, then paid
    IF v_user.free_credits > 0 THEN
      v_actual_type := 'free';
    ELSIF v_user.paid_credits > 0 THEN
      v_actual_type := 'paid';
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  -- Debit the credit
  IF v_actual_type = 'free' THEN
    UPDATE users SET free_credits = free_credits - 1 WHERE telegram_id = p_telegram_id;
  ELSE
    UPDATE users SET paid_credits = paid_credits - 1 WHERE telegram_id = p_telegram_id;
  END IF;

  -- Create the generation record atomically with the credit debit
  INSERT INTO generations (
    id,
    user_id,
    type,
    package_id,
    status,
    reference_paths,
    original_path,
    style_ids,
    prompt_preset,
    results_total,
    results_completed,
    expires_at,
    telegram_chat_id,
    telegram_user_id,
    credit_type,
    credit_consumed,
    last_heartbeat_at
  ) VALUES (
    p_generation_id,
    p_telegram_id::TEXT,
    p_prompt_tier,
    p_package_id,
    'processing',
    p_reference_paths,
    COALESCE(p_reference_paths[1], NULL),
    p_style_ids,
    COALESCE(p_style_ids[1], NULL),
    p_results_total,
    0,
    p_expires_at,
    p_telegram_chat_id,
    p_telegram_id,
    v_actual_type,
    true,
    now()
  );

  RETURN v_actual_type;
END;
$$;

COMMENT ON FUNCTION reserve_credit_and_create_generation IS
  'Single-transaction credit debit + generation row insert. '
  'Prevents partial-failure states (credit spent without a generation record, or vice versa).';
