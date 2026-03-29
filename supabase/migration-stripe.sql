-- ============================================================
--  claw-me.com — Stripe Billing Migration
--  Run in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── 1. Update plan names: starter→standard, pro→professional, enterprise→business ──

-- Drop the existing CHECK constraint
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_plan_check;

-- Add new CHECK with updated plan names
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check
  CHECK (plan IN ('standard','professional','business'));

-- Migrate existing data
UPDATE tenants SET plan = 'standard'     WHERE plan = 'starter';
UPDATE tenants SET plan = 'professional' WHERE plan = 'pro';
UPDATE tenants SET plan = 'business'     WHERE plan = 'enterprise';

-- Add Stripe price ID column for tracking which price the tenant is on
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_price TEXT;


-- ── 2. Checkout sessions tracking ─────────────────────────────
-- Track Stripe Checkout sessions so we can correlate pending signups
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stripe_session  TEXT NOT NULL UNIQUE,       -- Stripe Checkout Session ID (cs_...)
  stripe_customer TEXT,                       -- Stripe customer ID (cus_...)
  email           TEXT,
  plan            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','expired')),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkout_session ON checkout_sessions(stripe_session);
CREATE INDEX IF NOT EXISTS idx_checkout_email   ON checkout_sessions(email);


-- ── 3. Subscription events log ────────────────────────────────
-- Immutable log of every Stripe webhook event we process
CREATE TABLE IF NOT EXISTS stripe_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stripe_event_id TEXT NOT NULL UNIQUE,       -- evt_... (idempotency key)
  event_type      TEXT NOT NULL,              -- e.g. invoice.payment_succeeded
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  payload         JSONB NOT NULL,
  processed_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_type
  ON stripe_events(event_type, processed_at DESC);


-- ── 4. Update the plan limits view ────────────────────────────
CREATE OR REPLACE VIEW tenant_plan_limits AS
SELECT
  t.id           AS tenant_id,
  t.name,
  t.plan,
  t.status,
  COALESCE(u.tasks_run, 0)    AS tasks_this_month,
  COALESCE(u.tokens_used, 0)  AS tokens_this_month,
  CASE t.plan
    WHEN 'standard'     THEN 500
    WHEN 'professional' THEN 5000
    WHEN 'business'     THEN 999999999
  END AS task_limit,
  ROUND(
    COALESCE(u.tasks_run, 0)::NUMERIC /
    NULLIF(CASE t.plan
      WHEN 'standard'     THEN 500
      WHEN 'professional' THEN 5000
      WHEN 'business'     THEN 999999999
    END, 0) * 100, 1
  ) AS pct_used
FROM tenants t
LEFT JOIN usage u
  ON u.tenant_id = t.id
  AND u.period_start = DATE_TRUNC('month', NOW())::DATE;


-- ── 5. RLS for new tables ─────────────────────────────────────
ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events     ENABLE ROW LEVEL SECURITY;

-- Admin-only via service role; anon can insert checkout sessions
CREATE POLICY checkout_anon_insert ON checkout_sessions
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY checkout_anon_read ON checkout_sessions
  FOR SELECT TO anon USING (true);

CREATE POLICY stripe_events_admin ON stripe_events
  FOR ALL TO anon USING (true);
