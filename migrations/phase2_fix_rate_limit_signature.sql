-- ─── Phase 2: Fix check_rate_limit signature + guarantee user_rate_limits ─────
--
-- Incident:
--   Free-tier users were being hard-locked with log line "retry in trues" —
--   root cause was a prior hand-edited deploy of check_rate_limit that
--   returned BOOLEAN instead of INT seconds. Node code does `waitSec > 0`,
--   boolean true coerces to truthy, and `${true}s` renders "trues".
--
--   This migration:
--     1. Drops any conflicting overload of check_rate_limit (wrong return type
--        or wrong arg types) to avoid ambiguity.
--     2. Recreates the canonical signature: RETURNS INT (seconds to wait).
--     3. Ensures user_rate_limits table exists (idempotent baseline).
--     4. Adds clear_rate_limit() RPC as an optional server-side helper
--        (the server currently does a direct UPDATE which is fine — this is
--        provided for parity and future use).
--
-- Idempotent. Safe to run multiple times.

-- ─── 1. Table baseline ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_rate_limits (
  user_id          BIGINT      PRIMARY KEY,
  last_generation  TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation_count INT         NOT NULL DEFAULT 1,
  window_start     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 2. Drop any mis-typed overload ─────────────────────────────────────────
-- Postgres allows multiple functions with the same name if arg signatures
-- differ. If a previous deploy created a BOOLEAN-returning variant with a
-- different arg list, PostgREST will pick whichever overload matches the
-- call args, which may not be the one we want. We drop every known-bad
-- shape here, guarded by IF EXISTS so this is safe on fresh databases.
DROP FUNCTION IF EXISTS check_rate_limit(BIGINT);
DROP FUNCTION IF EXISTS check_rate_limit(BIGINT, BIGINT);
DROP FUNCTION IF EXISTS check_rate_limit(BIGINT, INT);
DROP FUNCTION IF EXISTS check_rate_limit(BIGINT, INTEGER);

-- ─── 3. Canonical check_rate_limit: INT seconds to wait ─────────────────────
-- Contract:
--   Returns 0      → user may proceed immediately.
--   Returns N > 0  → user must wait N seconds before retrying.
--
-- Side-effect: on a successful (non-blocked) check we stamp
-- last_generation = now(). The caller can roll this back via
-- clear_rate_limit(user_id) if the downstream work fails before the user
-- actually received value.
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id          BIGINT,
  p_cooldown_seconds INT DEFAULT 120
) RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_gen TIMESTAMPTZ;
  v_elapsed  INT;
BEGIN
  SELECT last_generation INTO v_last_gen
  FROM user_rate_limits
  WHERE user_id = p_user_id;

  IF v_last_gen IS NULL THEN
    -- First request for this user — record and allow.
    INSERT INTO user_rate_limits (user_id, last_generation)
    VALUES (p_user_id, now())
    ON CONFLICT (user_id) DO UPDATE
      SET last_generation = EXCLUDED.last_generation;
    RETURN 0;
  END IF;

  v_elapsed := EXTRACT(EPOCH FROM (now() - v_last_gen))::INT;

  IF v_elapsed >= p_cooldown_seconds THEN
    UPDATE user_rate_limits
    SET last_generation  = now(),
        generation_count = generation_count + 1
    WHERE user_id = p_user_id;
    RETURN 0;
  END IF;

  -- Still cooling down — return remaining seconds.
  RETURN GREATEST(0, p_cooldown_seconds - v_elapsed);
END;
$$;

-- ─── 4. Optional helper: server-side rollback RPC ───────────────────────────
-- The Node server (dbQueue.ts → clearRateLimit) currently writes directly
-- via the Supabase JS client. This RPC mirrors that behaviour for any
-- future call site that prefers an RPC contract over table writes.
CREATE OR REPLACE FUNCTION clear_rate_limit(p_user_id BIGINT) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE user_rate_limits
  SET last_generation = to_timestamp(0)  -- 1970-01-01, effectively "never"
  WHERE user_id = p_user_id;
END;
$$;

-- ─── Verification ───────────────────────────────────────────────────────────
-- After running:
--   SELECT check_rate_limit(999999999, 120);  -- should return 0 (int), not BOOLEAN
--   SELECT check_rate_limit(999999999, 120);  -- same user again, should return 120
--   SELECT clear_rate_limit(999999999);
--   SELECT check_rate_limit(999999999, 120);  -- should return 0 again
