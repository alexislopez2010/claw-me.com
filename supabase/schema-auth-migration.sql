-- ============================================================
--  claw-me.com — Auth Migration: Password + MFA Support
--  Run this in: Supabase Dashboard → SQL Editor → New Query
--  Prerequisites: Run AFTER the base schema.sql
-- ============================================================

-- ── Enable pgcrypto for bcrypt hashing ─────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── Add password columns to users table ────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash         TEXT,
  ADD COLUMN IF NOT EXISTS must_change_password   BOOLEAN DEFAULT FALSE;


-- ── MFA Codes table ────────────────────────────────────────
-- Stores 6-digit email codes with 5-minute expiry
CREATE TABLE IF NOT EXISTS mfa_codes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT NOT NULL,
  code            TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  attempts        INTEGER DEFAULT 0,
  used            BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mfa_codes_email
  ON mfa_codes(email, created_at DESC);


-- ── Password hashing functions (bcrypt via pgcrypto) ───────

-- Hash a plaintext password → bcrypt hash
CREATE OR REPLACE FUNCTION hash_password(pwd TEXT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT crypt(pwd, gen_salt('bf', 10));
$$;

-- Verify a plaintext password against a bcrypt hash
CREATE OR REPLACE FUNCTION verify_password(pwd TEXT, hashed TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT crypt(pwd, hashed) = hashed;
$$;

-- JSON wrapper for n8n (returns object instead of bare string)
CREATE OR REPLACE FUNCTION hash_password_json(pwd TEXT)
RETURNS JSON LANGUAGE sql SECURITY DEFINER AS $$
  SELECT json_build_object('hash', crypt(pwd, gen_salt('bf', 10)));
$$;


-- ── MFA helpers ────────────────────────────────────────────

-- Clean up expired MFA codes (run periodically or on each login)
CREATE OR REPLACE FUNCTION cleanup_expired_mfa_codes()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM mfa_codes WHERE expires_at < NOW() OR used = TRUE;
$$;


-- ── RLS for mfa_codes ──────────────────────────────────────
ALTER TABLE mfa_codes ENABLE ROW LEVEL SECURITY;

-- Only service_role can access mfa_codes (auth worker uses service key)
-- No public/anon policies — all access is via service_role
