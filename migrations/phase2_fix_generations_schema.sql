-- ─── Phase 2: Fix generations schema (Watchdog + credits) ──────────────────────
-- Root cause of prod failures:
--   • reclaim_orphaned_generations does `SET updated_at = now()` but the column
--     was never guaranteed to exist → "column updated_at does not exist".
--   • Some installations predate safe_credits_and_queue.sql and are missing
--     credit_type / credit_consumed / credit_refunded → "column g.credit_type
--     does not exist" when the RPC returns.
--   • last_heartbeat_at (added by phase1_watchdog_and_heartbeat.sql) is also
--     asserted here as a defence in depth in case that migration was skipped.
--
-- Idempotent: safe to run multiple times. Apply this once in the Supabase SQL
-- editor, then re-deploy the server. No code rollback is required afterwards.

-- ─── 1. Guarantee all columns the Watchdog and /api/generate rely on ──────────
ALTER TABLE generations
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS credit_type       TEXT        CHECK (credit_type IN ('free', 'paid')),
  ADD COLUMN IF NOT EXISTS credit_consumed   BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS credit_refunded   BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Indexes (no-op if already present)
CREATE INDEX IF NOT EXISTS idx_generations_credit
  ON generations (credit_consumed, credit_refunded)
  WHERE credit_consumed = true AND credit_refunded = false;

CREATE INDEX IF NOT EXISTS idx_generations_processing_heartbeat
  ON generations (last_heartbeat_at)
  WHERE status = 'processing';

-- ─── 2. Trigger: keep updated_at automatically fresh on any UPDATE ────────────
-- This matches the pattern already used for generation_queue. Without it we'd
-- need to sprinkle `updated_at = now()` across every UPDATE in the codebase,
-- which is how the original bug slipped in.
CREATE OR REPLACE FUNCTION set_updated_at_on_generations() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_generations_updated_at ON generations;
CREATE TRIGGER trg_generations_updated_at
  BEFORE UPDATE ON generations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at_on_generations();

-- ─── 3. Re-apply the Watchdog RPC so it picks up the fresh columns ────────────
-- CREATE OR REPLACE recompiles the function against the current table schema.
-- Without this, Postgres keeps the cached plan that referenced the missing
-- columns and keeps throwing even after the ALTER TABLE above.
CREATE OR REPLACE FUNCTION reclaim_orphaned_generations(
  p_stale_seconds INT DEFAULT 600
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
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  )
  UPDATE generations g
  SET status        = 'failed',
      error_message = COALESCE(g.error_message, 'Orphaned generation reclaimed by watchdog (no heartbeat).')
  FROM stale
  WHERE g.id = stale.id
  RETURNING
    g.id,
    g.telegram_user_id,
    g.credit_type,
    g.created_at;
END;
$$;
-- NB: we intentionally dropped the explicit `updated_at = now()` from the
-- UPDATE. The new trigger above handles it uniformly for every UPDATE path.

-- ─── 4. Re-apply heartbeat RPC (unchanged, but force recompile) ──────────────
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

-- ─── Verification helpers ────────────────────────────────────────────────────
-- After running this, these queries should all succeed:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'generations'
--   ORDER BY ordinal_position;
--
--   -- Dry-run the watchdog RPC (should return 0 rows on a healthy system):
--   SELECT * FROM reclaim_orphaned_generations(600);
