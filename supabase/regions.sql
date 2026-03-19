-- ============================================================
--  claw-me.com — Region Routing Schema
--  Run this in: Supabase Dashboard → SQL Editor → New Query
--  Run AFTER schema.sql
-- ============================================================

-- ── REGION REGISTRY ─────────────────────────────────────────
-- Reference table of all supported AWS regions
CREATE TABLE regions (
  id              TEXT PRIMARY KEY,            -- e.g. 'us-east-1'
  name            TEXT NOT NULL,               -- e.g. 'US East (N. Virginia)'
  cluster         TEXT NOT NULL,               -- ECS cluster name
  is_active       BOOLEAN DEFAULT true,        -- disable a region without deleting
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO regions (id, name, cluster) VALUES
  ('us-east-1',      'US East (N. Virginia)',    'claw-me-cluster-use1'),
  ('us-west-2',      'US West (Oregon)',          'claw-me-cluster-usw2'),
  ('ca-central-1',   'Canada (Central)',          'claw-me-cluster-cac1'),
  ('eu-west-1',      'Europe (Ireland)',          'claw-me-cluster-euw1'),
  ('eu-central-1',   'Europe (Frankfurt)',        'claw-me-cluster-euc1'),
  ('ap-southeast-1', 'Asia Pacific (Singapore)',  'claw-me-cluster-apse1'),
  ('ap-northeast-1', 'Asia Pacific (Tokyo)',      'claw-me-cluster-apne1'),
  ('ap-southeast-2', 'Asia Pacific (Sydney)',     'claw-me-cluster-apse2'),
  ('sa-east-1',      'South America (São Paulo)', 'claw-me-cluster-sae1');


-- ── COUNTRY → REGION MAPPING ────────────────────────────────
-- Reference table mapping ISO country codes to AWS regions
-- Useful for reporting and allows runtime overrides without redeploying Lambda
CREATE TABLE country_regions (
  country_code    TEXT PRIMARY KEY,            -- ISO 3166-1 alpha-2 e.g. 'US'
  country_name    TEXT NOT NULL,
  region_id       TEXT NOT NULL REFERENCES regions(id),
  gdpr_required   BOOLEAN DEFAULT false        -- true = must stay in EU
);

INSERT INTO country_regions (country_code, country_name, region_id, gdpr_required) VALUES
  -- North America
  ('US', 'United States',    'us-east-1',      false),
  ('CA', 'Canada',           'ca-central-1',   false),
  ('MX', 'Mexico',           'us-east-1',      false),
  -- South America
  ('BR', 'Brazil',           'sa-east-1',      false),
  ('AR', 'Argentina',        'sa-east-1',      false),
  ('CL', 'Chile',            'sa-east-1',      false),
  ('CO', 'Colombia',         'sa-east-1',      false),
  -- Europe (GDPR)
  ('GB', 'United Kingdom',   'eu-west-1',      true),
  ('IE', 'Ireland',          'eu-west-1',      true),
  ('FR', 'France',           'eu-central-1',   true),
  ('DE', 'Germany',          'eu-central-1',   true),
  ('NL', 'Netherlands',      'eu-west-1',      true),
  ('BE', 'Belgium',          'eu-west-1',      true),
  ('CH', 'Switzerland',      'eu-central-1',   true),
  ('AT', 'Austria',          'eu-central-1',   true),
  ('IT', 'Italy',            'eu-central-1',   true),
  ('ES', 'Spain',            'eu-west-1',      true),
  ('PT', 'Portugal',         'eu-west-1',      true),
  ('SE', 'Sweden',           'eu-central-1',   true),
  ('NO', 'Norway',           'eu-central-1',   true),
  ('DK', 'Denmark',          'eu-central-1',   true),
  ('FI', 'Finland',          'eu-central-1',   true),
  ('PL', 'Poland',           'eu-central-1',   true),
  -- Middle East & Africa
  ('AE', 'UAE',              'eu-central-1',   false),
  ('SA', 'Saudi Arabia',     'eu-central-1',   false),
  ('ZA', 'South Africa',     'eu-west-1',      false),
  -- Asia Pacific
  ('JP', 'Japan',            'ap-northeast-1', false),
  ('KR', 'South Korea',      'ap-northeast-1', false),
  ('SG', 'Singapore',        'ap-southeast-1', false),
  ('IN', 'India',            'ap-southeast-1', false),
  ('AU', 'Australia',        'ap-southeast-2', false),
  ('NZ', 'New Zealand',      'ap-southeast-2', false);


-- ── TENANT REGION VIEW ───────────────────────────────────────
-- Handy view for Retool admin portal — shows where each tenant is running
CREATE OR REPLACE VIEW tenant_regions AS
SELECT
  t.id           AS tenant_id,
  t.name         AS tenant_name,
  t.email,
  t.plan,
  t.status,
  i.region,
  r.name         AS region_name,
  r.is_active    AS region_active,
  cr.gdpr_required,
  i.endpoint_url,
  i.status       AS instance_status,
  i.last_health_at
FROM tenants t
LEFT JOIN instances i  ON i.tenant_id = t.id
LEFT JOIN regions r    ON r.id = i.region
LEFT JOIN country_regions cr ON cr.region_id = i.region;


-- ── RLS for new tables ───────────────────────────────────────
-- Regions and country mappings are public read (no sensitive data)
ALTER TABLE regions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE country_regions ENABLE ROW LEVEL SECURITY;

CREATE POLICY regions_public_read ON regions
  FOR SELECT USING (true);

CREATE POLICY country_regions_public_read ON country_regions
  FOR SELECT USING (true);
