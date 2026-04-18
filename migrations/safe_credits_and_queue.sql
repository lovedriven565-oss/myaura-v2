-- ─── Safe Credits & Database Queue Migration ─────────────────────────────────
-- Run this in Supabase SQL editor BEFORE deploying the code changes.
-- This replaces in-memory state (queue, rate limits) with database tables.

-- 1. RPC: refund_credit ──────────────────────────────────────────────────────
-- Returns credit to user if generation failed or delivery failed.
-- Idempotent: safe to call multiple times (returns TRUE if actually refunded).
CREATE OR REPLACE FUNCTION refund_credit(
  p_telegram_id BIGINT,
  p_type TEXT,  -- 'free' or 'paid'
  p_generation_id UUID,
  p_reason TEXT DEFAULT 'generation_failed'
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_already_refunded BOOLEAN;
BEGIN
  -- Check if already refunded for this generation
  SELECT EXISTS(
    SELECT 1 FROM credit_refunds 
    WHERE generation_id = p_generation_id AND refunded = true
  ) INTO v_already_refunded;
  
  IF v_already_refunded THEN
    RETURN FALSE;  -- Already refunded
  END IF;
  
  -- Record the refund attempt
  INSERT INTO credit_refunds (generation_id, user_id, credit_type, reason, refunded)
  VALUES (p_generation_id, p_telegram_id, p_type, p_reason, true)
  ON CONFLICT (generation_id) DO UPDATE SET 
    reason = EXCLUDED.reason,
    refunded = true,
    refunded_at = now();
  
  -- Actually refund the credit
  IF p_type = 'free' THEN
    UPDATE users SET free_credits = free_credits + 1 WHERE telegram_id = p_telegram_id;
  ELSE
    UPDATE users SET paid_credits = paid_credits + 1 WHERE telegram_id = p_telegram_id;
  END IF;
  
  RETURN TRUE;
END;
$$;

-- 2. Credit refunds table (for idempotency and audit log) ──────────────────────
CREATE TABLE IF NOT EXISTS credit_refunds (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id  UUID        NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  user_id        BIGINT      NOT NULL,
  credit_type    TEXT        NOT NULL CHECK (credit_type IN ('free', 'paid')),
  reason         TEXT        NOT NULL,
  refunded       BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_at    TIMESTAMPTZ,
  UNIQUE (generation_id)
);

CREATE INDEX IF NOT EXISTS idx_credit_refunds_user ON credit_refunds(user_id, created_at);

-- 3. Database queue table (replaces in-memory PQueue) ──────────────────────────
-- Cloud Run safe: survives container restarts and scales horizontally.
CREATE TABLE IF NOT EXISTS generation_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id   UUID        NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  priority        INT         NOT NULL DEFAULT 0,  -- Higher = process first
  attempts        INT         NOT NULL DEFAULT 0,
  max_attempts    INT         NOT NULL DEFAULT 3,
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  worker_id       TEXT,       -- For debugging which instance processed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gen_queue_status_scheduled 
  ON generation_queue(status, scheduled_at, priority) 
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_gen_queue_gen_id ON generation_queue(generation_id);

-- 4. RPC: dequeue_next_generation ──────────────────────────────────────────────
-- Atomically claims the next pending generation from the queue.
-- Returns the generation_id or NULL if queue empty.
CREATE OR REPLACE FUNCTION dequeue_next_generation(
  p_worker_id TEXT DEFAULT 'unknown'
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_queue_id UUID;
  v_gen_id UUID;
BEGIN
  -- Find and lock the next pending item
  SELECT id, generation_id INTO v_queue_id, v_gen_id
  FROM generation_queue
  WHERE status = 'pending' 
    AND scheduled_at <= now()
  ORDER BY priority DESC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
  
  IF v_queue_id IS NULL THEN
    RETURN NULL;
  END IF;
  
  -- Mark as processing
  UPDATE generation_queue
  SET status = 'processing',
      started_at = now(),
      worker_id = p_worker_id,
      attempts = attempts + 1,
      updated_at = now()
  WHERE id = v_queue_id;
  
  RETURN v_gen_id;
END;
$$;

-- 5. RPC: complete_queue_item ──────────────────────────────────────────────────
-- Marks queue item as completed or failed.
CREATE OR REPLACE FUNCTION complete_queue_item(
  p_generation_id UUID,
  p_success BOOLEAN,
  p_error_message TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE generation_queue
  SET status = CASE WHEN p_success THEN 'completed'::TEXT ELSE 'failed'::TEXT END,
      completed_at = CASE WHEN p_success THEN now() ELSE completed_at END,
      error_message = p_error_message,
      updated_at = now()
  WHERE generation_id = p_generation_id;
END;
$$;

-- 6. Database rate limit table (replaces in-memory _genRateMap) ───────────────
CREATE TABLE IF NOT EXISTS user_rate_limits (
  user_id         BIGINT      PRIMARY KEY REFERENCES users(telegram_id),
  last_generation TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation_count INT      NOT NULL DEFAULT 1,
  window_start    TIMESTAMPTZ NOT NULL DEFAULT now()  -- Rolling window
);

-- 7. RPC: check_rate_limit ───────────────────────────────────────────────────
-- Returns seconds until user can generate again (0 if allowed).
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id BIGINT,
  p_cooldown_seconds INT DEFAULT 120  -- 2 minutes default
) RETURNS INT  -- seconds to wait, 0 = allowed
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_gen TIMESTAMPTZ;
  v_elapsed INT;
BEGIN
  SELECT last_generation INTO v_last_gen
  FROM user_rate_limits
  WHERE user_id = p_user_id;
  
  IF v_last_gen IS NULL THEN
    -- First time user, record and allow
    INSERT INTO user_rate_limits (user_id, last_generation)
    VALUES (p_user_id, now())
    ON CONFLICT (user_id) DO UPDATE SET 
      last_generation = EXCLUDED.last_generation;
    RETURN 0;
  END IF;
  
  v_elapsed := EXTRACT(EPOCH FROM (now() - v_last_gen))::INT;
  
  IF v_elapsed >= p_cooldown_seconds THEN
    -- Update and allow
    UPDATE user_rate_limits 
    SET last_generation = now(), generation_count = generation_count + 1
    WHERE user_id = p_user_id;
    RETURN 0;
  END IF;
  
  -- Still cooling down
  RETURN p_cooldown_seconds - v_elapsed;
END;
$$;

-- 8. Trigger: Auto-cleanup old rate limit entries ──────────────────────────────
-- Run every hour to delete entries older than 24h (saves space)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits() RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM user_rate_limits 
  WHERE last_generation < now() - interval '24 hours';
END;
$$;

-- 9. Add columns to generations for credit tracking ────────────────────────────
ALTER TABLE generations 
  ADD COLUMN IF NOT EXISTS credit_type TEXT CHECK (credit_type IN ('free', 'paid')),
  ADD COLUMN IF NOT EXISTS credit_consumed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS credit_refunded BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_generations_credit ON generations(credit_consumed, credit_refunded) 
  WHERE credit_consumed = true AND credit_refunded = false;

COMMENT ON TABLE generation_queue IS 'CloudRun-safe job queue for AI generation tasks';
COMMENT ON TABLE user_rate_limits IS 'CloudRun-safe rate limiting per user';
COMMENT ON TABLE credit_refunds IS 'Audit log for refunded credits (idempotency)';
