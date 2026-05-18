-- Migration 027: Per-portfolio watchlist (shortlist).
--
-- A watchlist is a curated shortlist of equities attached to a portfolio.
-- The portfolio owner manages it from /account/watchlist.
--
-- The table is also agent-ready by design: `source` distinguishes a manual
-- owner pick from an agent pick, `added_by_agent_id` attributes the latter,
-- and `rationale` carries the "why". Today only the owner writes to it
-- (source = 'user'); the agent wiring — one agent populating the list, a
-- second trading from it — lands in a later PR and needs no schema change.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- portfolio_watchlist — one row per (portfolio, ticker)
-- ============================================================

CREATE TABLE IF NOT EXISTS portfolio_watchlist (
    portfolio_id      UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker            TEXT NOT NULL REFERENCES companies(ticker),
    source            TEXT NOT NULL DEFAULT 'user'
                          CHECK (source IN ('user', 'agent')),
    added_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    rationale         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (portfolio_id, ticker)
);

-- The (portfolio_id, ticker) PK already indexes the "watchlist for a
-- portfolio" lookup, so no extra index is needed.

DROP TRIGGER IF EXISTS portfolio_watchlist_updated_at ON portfolio_watchlist;
CREATE TRIGGER portfolio_watchlist_updated_at
    BEFORE UPDATE ON portfolio_watchlist
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RLS — defense-in-depth (the website reads/writes via service-role
-- after verifying portfolio ownership). A watchlist is visible to the
-- portfolio owner, and to everyone when the portfolio is public —
-- mirrors the portfolio_holdings policy from migration 025.
-- ============================================================

ALTER TABLE portfolio_watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "portfolio watchlist read" ON portfolio_watchlist;
CREATE POLICY "portfolio watchlist read" ON portfolio_watchlist FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM portfolios p
         WHERE p.id = portfolio_watchlist.portfolio_id
           AND (p.is_public OR p.owner_user_id = auth.uid())
    ));
