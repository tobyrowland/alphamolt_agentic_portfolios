-- Migration 040: Configurable screener as the funnel's selection stage.
--
-- The /screener page becomes both the configurable research tool AND the
-- selection stage of the funnel (screener brief v2): the ranked top N of the
-- screen feed the buyer directly. The separate watchlist_curator agent +
-- watchlist page are removed; a portfolio's "watchlist" is now just the top N
-- of its screen.
--
-- 1. screen_facts() — a STABLE function returning one row of Level 0 facts per
--    Tier 1 ticker (identity + latest fundamentals + latest valuation + last
--    price + trailing 52w return). The deterministic scoring-as-a-function
--    (web /screen + the Python buyer) ranks over this. Holds NO strategy —
--    the lens (filters + weights) lives in the caller's config.
-- 2. saved_screens — persisted, shareable screen recipes (the "Save" feature).
--    Public-read so a shared /screener?screen=<slug> link resolves logged-out;
--    owner-only writes.
-- 3. portfolios.screen_config — a portfolio's selection recipe (filters +
--    weights + topN). Replaces the removed watchlist: the buyer ranks Level 0
--    via screen_facts() against this and buys the top N.
--
-- Depends on migration 039 (Level 0 fact store). Idempotent.

-- ---- screen_facts() -------------------------------------------------------
CREATE OR REPLACE FUNCTION screen_facts()
RETURNS TABLE (
    ticker            TEXT,
    name              TEXT,
    sector            TEXT,
    industry          TEXT,
    country           TEXT,
    price             NUMERIC,
    price_asof        DATE,
    rev_growth_ttm    NUMERIC,
    gross_margin      NUMERIC,
    fcf_margin        NUMERIC,
    net_margin        NUMERIC,
    operating_margin  NUMERIC,
    rule_of_40        NUMERIC,
    ps                NUMERIC,
    ps_median_12m     NUMERIC,
    ret_52w           NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT
        s.ticker,
        s.name,
        s.gics_sector,
        s.gics_industry,
        s.country,
        lp.close,
        lp.date,
        f.rev_growth_ttm,
        f.gross_margin,
        f.fcf_margin,
        f.net_margin,
        f.operating_margin,
        f.rule_of_40,
        v.ps,
        v.ps_median_12m,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END AS ret_52w
    FROM securities s
    LEFT JOIN LATERAL (
        SELECT close, date FROM prices_daily pd
        WHERE pd.ticker = s.ticker ORDER BY pd.date DESC LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
        SELECT close FROM prices_daily pd
        WHERE pd.ticker = s.ticker AND pd.date <= (CURRENT_DATE - INTERVAL '52 weeks')
        ORDER BY pd.date DESC LIMIT 1
    ) p52 ON true
    LEFT JOIN LATERAL (
        SELECT * FROM fundamentals fd
        WHERE fd.ticker = s.ticker ORDER BY fd.period_end DESC LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
        SELECT * FROM valuation vl
        WHERE vl.ticker = s.ticker ORDER BY vl.date DESC LIMIT 1
    ) v ON true
    WHERE s.is_tier1 AND s.status = 'active';
$$;

-- ---- saved_screens --------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_screens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    slug          TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    config        JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_screens_owner ON saved_screens (owner_user_id);

DROP TRIGGER IF EXISTS saved_screens_updated_at ON saved_screens;
CREATE TRIGGER saved_screens_updated_at
    BEFORE UPDATE ON saved_screens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE saved_screens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read" ON saved_screens;
CREATE POLICY "public read" ON saved_screens FOR SELECT USING (true);
DROP POLICY IF EXISTS "owner insert" ON saved_screens;
CREATE POLICY "owner insert" ON saved_screens
    FOR INSERT WITH CHECK (auth.uid() = owner_user_id);
DROP POLICY IF EXISTS "owner update" ON saved_screens;
CREATE POLICY "owner update" ON saved_screens
    FOR UPDATE USING (auth.uid() = owner_user_id) WITH CHECK (auth.uid() = owner_user_id);
DROP POLICY IF EXISTS "owner delete" ON saved_screens;
CREATE POLICY "owner delete" ON saved_screens
    FOR DELETE USING (auth.uid() = owner_user_id);

-- ---- screen_ai_overlay() --------------------------------------------------
-- The optional AI bull/bear verdict overlay (a lens, NOT a Level 0 fact —
-- kept out of screen_facts() so that function stays strategy-neutral). The
-- verdict is the leading ✅/❌ of the narrative eval text in `companies`;
-- exposing it as a 1-char-derived boolean means the screener never fetches
-- the full narratives. NULL = no eval (the multiplier is then 1.0).
CREATE OR REPLACE FUNCTION screen_ai_overlay()
RETURNS TABLE (ticker TEXT, bull BOOLEAN, bear BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT ticker,
    CASE WHEN left(bull_eval,1)='✅' THEN true WHEN left(bull_eval,1)='❌' THEN false END,
    CASE WHEN left(bear_eval,1)='✅' THEN true WHEN left(bear_eval,1)='❌' THEN false END
  FROM companies
  WHERE bull_eval IS NOT NULL OR bear_eval IS NOT NULL;
$$;

-- ---- portfolios.screen_config --------------------------------------------
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS screen_config JSONB;
