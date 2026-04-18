-- ─── Telegram Stars Billing Migration ──────────────────────────────────────
-- P0: Payment system for Telegram Stars (XTR)

-- 1. Store packages table (if not exists) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS store_packages (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  generations     INT NOT NULL,
  stars_price     INT NOT NULL,  -- Price in XTR (Telegram Stars)
  is_hidden       BOOLEAN DEFAULT false,  -- Hidden from catalog, for testing
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. Insert TEST_1_STAR package (1 XTR for testing) ─────────────────────────
INSERT INTO store_packages (id, title, generations, stars_price, is_hidden)
VALUES ('TEST_1_STAR', 'Тест: 1 генерация', 1, 1, true)
ON CONFLICT (id) DO NOTHING;

-- 3. Payment events table for audit ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT NOT NULL REFERENCES users(telegram_id),
  package_id      TEXT NOT NULL REFERENCES store_packages(id),
  stars_amount    INT NOT NULL,
  telegram_payment_charge_id TEXT,  -- From Telegram successful_payment
  payload         TEXT,  -- Original payload from invoice
  status          TEXT CHECK (status IN ('pending', 'completed', 'failed')),
  credits_added   INT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_events_user ON payment_events(telegram_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_charge_id ON payment_events(telegram_payment_charge_id);

-- 4. RPC: add_paid_credits ─────────────────────────────────────────────────
-- Atomic credit addition with idempotency check via payment_events
CREATE OR REPLACE FUNCTION add_paid_credits(
  p_telegram_id BIGINT,
  p_credits INT,
  p_package_id TEXT,
  p_stars_amount INT,
  p_telegram_charge_id TEXT,
  p_payload TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id UUID;
BEGIN
  -- Check for duplicate payment (idempotency)
  IF p_telegram_charge_id IS NOT NULL THEN
    SELECT id INTO v_event_id
    FROM payment_events
    WHERE telegram_payment_charge_id = p_telegram_charge_id;
    
    IF v_event_id IS NOT NULL THEN
      RETURN FALSE;  -- Already processed
    END IF;
  END IF;
  
  -- Record the payment event
  INSERT INTO payment_events (
    telegram_id, package_id, stars_amount, 
    telegram_payment_charge_id, payload,
    status, credits_added, completed_at
  ) VALUES (
    p_telegram_id, p_package_id, p_stars_amount,
    p_telegram_charge_id, p_payload,
    'completed', p_credits, now()
  );
  
  -- Add paid credits to user
  UPDATE users
  SET paid_credits = paid_credits + p_credits
  WHERE telegram_id = p_telegram_id;
  
  RETURN TRUE;
END;
$$;

-- 5. View: user_payment_summary ───────────────────────────────────────────────
CREATE OR REPLACE VIEW user_payment_summary AS
SELECT 
  u.telegram_id,
  u.paid_credits,
  COALESCE(SUM(pe.stars_amount), 0) as total_stars_spent,
  COUNT(pe.id) as total_payments
FROM users u
LEFT JOIN payment_events pe ON pe.telegram_id = u.telegram_id AND pe.status = 'completed'
GROUP BY u.telegram_id, u.paid_credits;
