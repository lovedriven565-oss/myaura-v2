-- ─── Referral B-lite MVP Migration ───────────────────────────────────────────
-- Run this in Supabase SQL editor ONCE before deploying referral code.
-- Safe to re-run: all statements are idempotent (IF NOT EXISTS / OR REPLACE).

-- 1. Extend users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_code            TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS referred_by_code         TEXT,
  ADD COLUMN IF NOT EXISTS referral_rewards_given   INT NOT NULL DEFAULT 0;

-- 2. Backfill referral codes for existing users (run once, skips users that already have one)
UPDATE users
SET referral_code = 'ref_' || substr(md5(random()::text || telegram_id::text), 1, 8)
WHERE referral_code IS NULL;

-- 3. Referral events table: tracks each qualified referral award
--    UNIQUE(invitee_id) enforces "one invitee can award exactly one referrer"
CREATE TABLE IF NOT EXISTS referral_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id    BIGINT      NOT NULL REFERENCES users(telegram_id),
  invitee_id     BIGINT      NOT NULL REFERENCES users(telegram_id),
  generation_id  UUID        NOT NULL,
  awarded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invitee_id)
);

-- 4. RPC: award_referral_bonus
--    Called from Node.js after a qualified free generation completes.
--    Returns TRUE if the award was given, FALSE otherwise (idempotent, safe to call multiple times).
CREATE OR REPLACE FUNCTION award_referral_bonus(
  p_referrer_code TEXT,
  p_invitee_id    BIGINT,
  p_gen_id        UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_referrer_id     BIGINT;
  v_rewards_given   INT;
BEGIN
  -- 1. Look up referrer by code
  SELECT telegram_id, referral_rewards_given
    INTO v_referrer_id, v_rewards_given
  FROM users
  WHERE referral_code = p_referrer_code;

  -- 2. Guard: referrer must exist
  IF v_referrer_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- 3. Guard: self-referral
  IF v_referrer_id = p_invitee_id THEN
    RETURN FALSE;
  END IF;

  -- 4. Guard: cap = 3
  IF v_rewards_given >= 3 THEN
    RETURN FALSE;
  END IF;

  -- 5. Guard: already awarded for this invitee (UNIQUE constraint backup)
  BEGIN
    INSERT INTO referral_events (referrer_id, invitee_id, generation_id)
    VALUES (v_referrer_id, p_invitee_id, p_gen_id);
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;

  -- 6. Atomically credit the referrer
  UPDATE users
  SET free_credits          = free_credits + 1,
      referral_rewards_given = referral_rewards_given + 1
  WHERE telegram_id = v_referrer_id;

  RETURN TRUE;
END;
$$;

-- 5. RPC: set_referred_by
--    Writes referred_by_code only if it is currently NULL (one-time attribution).
CREATE OR REPLACE FUNCTION set_referred_by(
  p_telegram_id BIGINT,
  p_ref_code    TEXT
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users
  SET referred_by_code = p_ref_code
  WHERE telegram_id = p_telegram_id
    AND referred_by_code IS NULL
    AND p_ref_code IS NOT NULL
    AND p_ref_code != '';
END;
$$;

-- 6. RPC: ensure_referral_code
--    Generates a referral_code for a user if they don't have one yet.
CREATE OR REPLACE FUNCTION ensure_referral_code(p_telegram_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_code TEXT;
  v_attempts INT := 0;
BEGIN
  -- Return existing code if already set
  SELECT referral_code INTO v_code FROM users WHERE telegram_id = p_telegram_id;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  -- Generate unique code with retry loop (collision extremely unlikely but handled)
  LOOP
    v_code := 'ref_' || substr(md5(random()::text || p_telegram_id::text || v_attempts::text), 1, 8);
    v_attempts := v_attempts + 1;

    BEGIN
      UPDATE users SET referral_code = v_code WHERE telegram_id = p_telegram_id;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempts >= 5 THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;
