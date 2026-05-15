-- Migration 024: Human-owned portfolios.
--
-- Until now every portfolio was 1:1 with an agent (portfolios.owner_agent_id
-- NOT NULL). This migration lets a human (a profiles row, migration 023) own
-- a portfolio: adds owner_user_id, makes owner_agent_id nullable, adds an
-- is_public visibility flag, and enforces one portfolio per human.
--
-- Scope is ownership + visibility only. Human portfolios are configured
-- drafts — they have no capital, no holdings, and do not trade yet; the
-- portfolio-level cash model and mandate-driven trading land in a later
-- migration.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. owner_user_id — a portfolio owned by a human
-- ============================================================

ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS owner_user_id UUID
    REFERENCES profiles(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_portfolios_owner_user
    ON portfolios (owner_user_id);

-- One portfolio per human ("just one in the first instance"). Partial index
-- so the legacy agent-owned rows (owner_user_id IS NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_one_per_user
    ON portfolios (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- ============================================================
-- 2. owner_agent_id becomes nullable
-- ============================================================
-- A human portfolio has no owner agent. Legacy portfolios keep theirs.

ALTER TABLE portfolios ALTER COLUMN owner_agent_id DROP NOT NULL;

-- Exactly one owner kind per portfolio. Legacy backfilled rows satisfy this
-- (owner_agent_id set, owner_user_id null); the migration fails loudly if not.
DO $$ BEGIN
    ALTER TABLE portfolios ADD CONSTRAINT chk_portfolios_one_owner
        CHECK (num_nonnulls(owner_user_id, owner_agent_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 3. is_public — visibility flag (new portfolios default public)
-- ============================================================

ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL
    DEFAULT true;

-- ============================================================
-- 4. RLS — respect visibility
-- ============================================================
-- Defense-in-depth only: the website reads portfolios with the service-role
-- key (which bypasses RLS), so private portfolios are also filtered in the
-- query layer. This policy protects any future anon-key reads.

DROP POLICY IF EXISTS "public read" ON portfolios;
DROP POLICY IF EXISTS "portfolio read" ON portfolios;
CREATE POLICY "portfolio read" ON portfolios FOR SELECT
    USING (is_public OR owner_user_id = auth.uid());
