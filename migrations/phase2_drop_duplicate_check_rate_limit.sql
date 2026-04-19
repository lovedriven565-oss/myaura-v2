-- ─── Phase 2 hotfix: Drop duplicate check_rate_limit overloads ───────────────
--
-- Incident: PostgREST returned
--   "Could not choose the best candidate function between:
--    public.check_rate_limit(p_user_id => bigint, p_cooldown_seconds => integer),
--    public.check_rate_limit(p_user_id => bigint, p_cooldown_seconds => bigint)"
--
-- Root cause: a prior SQL run created TWO overloads with different second-arg
-- types (INT vs BIGINT), and the Supabase JS client sends INT — but PostgREST
-- cannot disambiguate because both are valid coercions.
--
-- Resolution: drop every overload, then re-create ONLY the canonical
-- (BIGINT, INT) → INT signature. Every client in this codebase calls it with
-- an INT cooldown (see src/server/dbQueue.ts:checkRateLimit), so this is safe.
--
-- Idempotent. Safe to run multiple times.

BEGIN;

-- ─── 1. Enumerate + drop ALL overloads of check_rate_limit ──────────────────
-- We use a DO block so we don't need to know every historical signature up
-- front — this catches any exotic variant a manual hotfix might have left.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name,
           p.proname AS func_name,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'check_rate_limit'
      AND n.nspname = 'public'
  LOOP
    RAISE NOTICE 'Dropping duplicate: %.%(%)', r.schema_name, r.func_name, r.args;
    EXECUTE format('DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE',
                   r.schema_name, r.func_name, r.args);
  END LOOP;
END
$$;

-- ─── 2. Recreate ONLY the canonical signature ───────────────────────────────
-- Contract:
--   RETURNS INT  — number of seconds the caller must wait.
--   0            — request is allowed (side effect: stamps last_generation).
--   > 0          — still cooling down.
CREATE TABLE IF NOT EXISTS user_rate_limits (
  user_id          BIGINT      PRIMARY KEY,
  last_generation  TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation_count INT         NOT NULL DEFAULT 1,
  window_start     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION check_rate_limit(
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

  RETURN GREATEST(0, p_cooldown_seconds - v_elapsed);
END;
$$;

-- ─── 3. clear_rate_limit helper (idempotent, also de-duped) ─────────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name,
           p.proname AS func_name,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'clear_rate_limit'
      AND n.nspname = 'public'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE',
                   r.schema_name, r.func_name, r.args);
  END LOOP;
END
$$;

CREATE FUNCTION clear_rate_limit(p_user_id BIGINT) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE user_rate_limits
  SET last_generation = to_timestamp(0)
  WHERE user_id = p_user_id;
END;
$$;

COMMIT;

-- ─── Verification ───────────────────────────────────────────────────────────
-- Exactly ONE row should come back from each of these after the migration:
--
--   SELECT proname, pg_get_function_identity_arguments(oid) AS args
--   FROM pg_proc
--   WHERE proname = 'check_rate_limit' AND pronamespace = 'public'::regnamespace;
--
--   SELECT proname, pg_get_function_identity_arguments(oid) AS args
--   FROM pg_proc
--   WHERE proname = 'clear_rate_limit' AND pronamespace = 'public'::regnamespace;
--
-- Smoke test:
--   SELECT check_rate_limit(999999999, 120);  -- expect: 0
--   SELECT check_rate_limit(999999999, 120);  -- expect: 120
--   SELECT clear_rate_limit(999999999);
--   SELECT check_rate_limit(999999999, 120);  -- expect: 0
