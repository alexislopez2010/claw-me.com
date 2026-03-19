-- ============================================================
--  claw-me.com — Supabase Database Schema
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ── TENANTS ─────────────────────────────────────────────────
-- One row per paying customer / organisation
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  plan            TEXT NOT NULL DEFAULT 'starter'
                    CHECK (plan IN ('starter','pro','enterprise')),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','cancelled','pending')),
  stripe_customer TEXT,                        -- Stripe customer ID
  stripe_sub      TEXT,                        -- Stripe subscription ID
  metadata        JSONB DEFAULT '{}',          -- flexible extra fields
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── INSTANCES ───────────────────────────────────────────────
-- The actual OpenClaw container running for each tenant
CREATE TABLE instances (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ecs_task_arn    TEXT,                        -- AWS ECS task ARN
  ecs_cluster     TEXT DEFAULT 'claw-me-cluster',
  endpoint_url    TEXT,                        -- https://tenant-abc.claw-me.com
  region          TEXT DEFAULT 'us-east-1',
  status          TEXT NOT NULL DEFAULT 'provisioning'
                    CHECK (status IN ('provisioning','running','stopped','error','deprovisioning')),
  last_health_at  TIMESTAMPTZ,                 -- last successful health check
  error_msg       TEXT,                        -- populated on status = 'error'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── USERS ───────────────────────────────────────────────────
-- Portal users (maps to Supabase auth.users)
CREATE TABLE users (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  display_name    TEXT,
  role            TEXT NOT NULL DEFAULT 'owner'
                    CHECK (role IN ('owner','member','viewer')),
  avatar_url      TEXT,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── USAGE ───────────────────────────────────────────────────
-- Monthly usage snapshots per tenant
CREATE TABLE usage (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  tasks_run       INTEGER DEFAULT 0,
  tokens_used     BIGINT DEFAULT 0,
  integrations    JSONB DEFAULT '{}',          -- { "gmail": 42, "slack": 18 }
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, period_start)
);


-- ── INTEGRATIONS ────────────────────────────────────────────
-- OAuth connections per tenant instance
CREATE TABLE integrations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,               -- 'gmail' | 'slack' | 'github' etc.
  status          TEXT NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connected','disconnected','error')),
  access_token    TEXT,                        -- encrypted at rest via Supabase vault
  refresh_token   TEXT,
  token_expires   TIMESTAMPTZ,
  scopes          TEXT[],
  metadata        JSONB DEFAULT '{}',
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── AUDIT LOG ───────────────────────────────────────────────
-- Admin-readable log of key events
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor           TEXT,                        -- 'system' | 'admin' | user email
  action          TEXT NOT NULL,               -- 'instance.provisioned' etc.
  payload         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── UPDATED_AT TRIGGERS ─────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER instances_updated_at
  BEFORE UPDATE ON instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── INDEXES ─────────────────────────────────────────────────
CREATE INDEX idx_instances_tenant    ON instances(tenant_id);
CREATE INDEX idx_instances_status    ON instances(status);
CREATE INDEX idx_users_tenant        ON users(tenant_id);
CREATE INDEX idx_usage_tenant_period ON usage(tenant_id, period_start DESC);
CREATE INDEX idx_integrations_tenant ON integrations(tenant_id);
CREATE INDEX idx_audit_tenant        ON audit_log(tenant_id, created_at DESC);


-- ── ROW LEVEL SECURITY ──────────────────────────────────────
-- Tenants can ONLY see their own data. Admins bypass via service_role key.

ALTER TABLE tenants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE instances    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log    ENABLE ROW LEVEL SECURITY;

-- Helper: get the tenant_id from the JWT (set during sign-in)
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT (auth.jwt() ->> 'tenant_id')::UUID;
$$;

-- Tenants: users see only their own row
CREATE POLICY tenants_self ON tenants
  FOR ALL USING (id = current_tenant_id());

-- Instances: users see only their tenant's instance
CREATE POLICY instances_tenant ON instances
  FOR ALL USING (tenant_id = current_tenant_id());

-- Users: users see only members of their tenant
CREATE POLICY users_tenant ON users
  FOR ALL USING (tenant_id = current_tenant_id());

-- Usage: users see only their tenant's usage
CREATE POLICY usage_tenant ON usage
  FOR ALL USING (tenant_id = current_tenant_id());

-- Integrations: users see only their tenant's integrations
CREATE POLICY integrations_tenant ON integrations
  FOR ALL USING (tenant_id = current_tenant_id());

-- Audit log: users can read their tenant's log, not write
CREATE POLICY audit_read ON audit_log
  FOR SELECT USING (tenant_id = current_tenant_id());


-- ── SEED: PLAN LIMITS VIEW ──────────────────────────────────
-- Handy view to check if a tenant is within their plan limits
CREATE OR REPLACE VIEW tenant_plan_limits AS
SELECT
  t.id           AS tenant_id,
  t.name,
  t.plan,
  t.status,
  COALESCE(u.tasks_run, 0)    AS tasks_this_month,
  COALESCE(u.tokens_used, 0)  AS tokens_this_month,
  CASE t.plan
    WHEN 'starter'    THEN 500
    WHEN 'pro'        THEN 5000
    WHEN 'enterprise' THEN 999999999
  END AS task_limit,
  ROUND(
    COALESCE(u.tasks_run, 0)::NUMERIC /
    NULLIF(CASE t.plan
      WHEN 'starter'    THEN 500
      WHEN 'pro'        THEN 5000
      WHEN 'enterprise' THEN 999999999
    END, 0) * 100, 1
  ) AS pct_used
FROM tenants t
LEFT JOIN usage u
  ON u.tenant_id = t.id
  AND u.period_start = DATE_TRUNC('month', NOW())::DATE;
