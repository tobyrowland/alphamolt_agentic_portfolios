-- Migration 051: per-portfolio screener rejections (90-day auto-hide).
--
-- When a portfolio's BUY agent evaluates a candidate for purchase and DOESN'T
-- buy it (a PASS verdict, or a BUY below its conviction gate), the name is
-- recorded here. The screener's "hide rejected" toggle (on by default, stored
-- in portfolios.screen_config.hideRejected) then drops it from BOTH the
-- screener results and the buyer's candidate pool for 90 days, so the agent
-- doesn't churn straight back to re-evaluating a name it just passed on. The
-- owner can manually restore a name early from the screener.
--
-- This is the per-portfolio cousin of the manual, global 1-year blocklist in
-- migration 048 (screener_exclusions). Two differences:
--   * scoped to a portfolio (a name one mandate passes on is still visible to
--     another portfolio with a different mandate);
--   * auto-populated by the buyer (llm_watchlist_buyer), refreshed on each
--     re-rejection, cleared on an actual buy, expiring after 90 days.
--
-- Applied at read time, honouring screen_config.hideRejected:
--   * screen.py  portfolio_screen_candidates()  -> the Python buyer's pool
--   * web/lib/screen/query.ts runScreen(..., rejected)  -> the screener page
--   * web/app/api/screen/route.ts               -> the live re-rank
--
-- RLS: enabled with NO policies, so ONLY the service role can read or write.
-- Unlike screener_exclusions (public-read), a portfolio's rejection list can
-- belong to a PRIVATE portfolio, so it must not be world-readable. The website
-- reads it server-side with the service key; the Python buyer bypasses RLS.
--
-- Additive & idempotent.

CREATE TABLE IF NOT EXISTS screener_rejections (
    portfolio_id        UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    ticker              TEXT NOT NULL,
    rejected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    rejected_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    verdict             TEXT,          -- 'PASS' | 'BUY' (sub-gate) — the agent's call
    conviction          INT,           -- 1-5, the agent's conviction at evaluation
    reason              TEXT,          -- short rationale snippet (the "why")
    restored_at         TIMESTAMPTZ,   -- set when the owner manually restores it early
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (portfolio_id, ticker)
);

-- Active-rejection lookups: WHERE portfolio_id = ? AND expires_at > now()
-- AND restored_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_screener_rejections_active
    ON screener_rejections (portfolio_id, expires_at)
    WHERE restored_at IS NULL;

ALTER TABLE screener_rejections ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only (matches lifecycle_email_sends, migration 050).
