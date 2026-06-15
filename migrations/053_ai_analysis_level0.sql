-- Migration 053 (Stage A1): a Level 0 home for AI analysis (bull/bear + narratives).
--
-- The screener's AI multiplier and the buyer's enrichment read bull/bear +
-- narratives from `companies` — the legacy TradingView-selected universe. To
-- let those cover the full Tier-1 universe (and ultimately retire `companies`),
-- AI analysis moves to its own table, `ai_analysis`, keyed by ticker.
--
-- This migration is the SAFE first step (A1): create the table, SEED it from
-- the existing companies AI columns (zero coverage loss), and repoint the read
-- paths (screen_ai_overlay + screen_facts_mv) to it. The evaluation scripts
-- dual-write `ai_analysis` alongside `companies` (accompanying Python change),
-- so it stays fresh. A2 repoints those scripts' INPUT to the Tier-1 universe so
-- coverage actually expands beyond the legacy screen.
--
-- No FK on ticker (this is a derived opinion/lens table, not a Level 0 fact
-- table): keeps the dual-write from ever failing a screen ticker that isn't yet
-- in `securities`, and the screener join (screen_facts_mv WHERE is_tier1) drops
-- any stray row anyway. Public-read (the overlay is read anon/SSR), service
-- writes. Additive & idempotent.

CREATE TABLE IF NOT EXISTS ai_analysis (
    ticker         TEXT PRIMARY KEY,
    bull_eval      TEXT,
    bear_eval      TEXT,
    short_outlook  TEXT,
    key_risks      TEXT,
    full_outlook   TEXT,
    event_impact   TEXT,
    analyzed_at    TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS ai_analysis_updated_at ON ai_analysis;
CREATE TRIGGER ai_analysis_updated_at
    BEFORE UPDATE ON ai_analysis
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE ai_analysis ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read ai_analysis" ON ai_analysis;
CREATE POLICY "public read ai_analysis" ON ai_analysis FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policy → writes are service-role only.

-- ---- Seed from the existing companies AI columns (no coverage loss) -------
INSERT INTO ai_analysis (
    ticker, bull_eval, bear_eval, short_outlook, key_risks, full_outlook,
    event_impact, analyzed_at
)
SELECT ticker, bull_eval, bear_eval, short_outlook, key_risks, full_outlook,
       event_impact, ai_analyzed_at
FROM companies
WHERE bull_eval IS NOT NULL OR bear_eval IS NOT NULL
   OR short_outlook IS NOT NULL OR full_outlook IS NOT NULL
   OR key_risks IS NOT NULL OR event_impact IS NOT NULL
ON CONFLICT (ticker) DO NOTHING;

-- ---- Repoint screen_ai_overlay() to ai_analysis --------------------------
CREATE OR REPLACE FUNCTION screen_ai_overlay()
RETURNS TABLE (ticker TEXT, bull BOOLEAN, bear BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT ticker,
    CASE WHEN left(bull_eval,1)='✅' THEN true WHEN left(bull_eval,1)='❌' THEN false END,
    CASE WHEN left(bear_eval,1)='✅' THEN true WHEN left(bear_eval,1)='❌' THEN false END
  FROM ai_analysis
  WHERE bull_eval IS NOT NULL OR bear_eval IS NOT NULL;
$$;

-- ---- Repoint screen_facts_mv's bull/bear join to ai_analysis -------------
-- Same definition as migration 044, with the AI join moved companies -> ai_analysis.
-- (screen_facts() reads this matview and is unchanged.)
DROP MATERIALIZED VIEW IF EXISTS screen_facts_mv;
CREATE MATERIALIZED VIEW screen_facts_mv AS
    SELECT
        s.ticker,
        s.name,
        s.gics_sector       AS sector,
        s.gics_industry     AS industry,
        s.country,
        lp.close            AS price,
        lp.date             AS price_asof,
        f.rev_growth_ttm,
        f.gross_margin,
        f.fcf_margin,
        f.net_margin,
        f.operating_margin,
        f.rule_of_40,
        v.ps,
        v.ps_median_12m,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END AS ret_52w,
        CASE WHEN left(a.bull_eval, 1) = '✅' THEN true
             WHEN left(a.bull_eval, 1) = '❌' THEN false END AS bull,
        CASE WHEN left(a.bear_eval, 1) = '✅' THEN true
             WHEN left(a.bear_eval, 1) = '❌' THEN false END AS bear
    FROM securities s
    JOIN LATERAL (
        SELECT rev_growth_ttm, gross_margin, fcf_margin, net_margin,
               operating_margin, rule_of_40
        FROM fundamentals fd
        WHERE fd.ticker = s.ticker ORDER BY fd.period_end DESC LIMIT 1
    ) f ON true
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
        SELECT ps, ps_median_12m FROM valuation vl
        WHERE vl.ticker = s.ticker ORDER BY vl.date DESC LIMIT 1
    ) v ON true
    LEFT JOIN ai_analysis a ON a.ticker = s.ticker
    WHERE s.is_tier1 AND s.status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS screen_facts_mv_ticker ON screen_facts_mv (ticker);
GRANT SELECT ON screen_facts_mv TO anon, authenticated, service_role;
