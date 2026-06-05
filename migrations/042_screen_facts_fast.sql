-- Migration 042: make screen_facts() a single, fast, self-contained read.
--
-- The screener's loadFacts was paginating screen_facts() (3223 rows → 4 calls,
-- each re-executing the function) AND calling screen_ai_overlay() separately
-- (2 more calls) on every page load, uncached — which tipped over the
-- statement/function timeout and made the page slow.
--
-- Fix:
--   1. INNER JOIN the latest fundamentals so the function returns only the
--      rankable tickers (~900 — one PostgREST page, no blank rows on the page).
--   2. Fold the AI bull/bear verdict in as two columns (bull, bear) so the
--      overlay no longer needs a separate round-trip.
-- The lateral lookups are unchanged (~155ms). screen_ai_overlay() stays in
-- place (the Python buyer still reads it). The web caches this for 5 minutes
-- (web/lib/screen/query.ts) so it runs at most once per window, not per request.
--
-- Changing the return signature requires DROP + CREATE. Depends on migrations
-- 039 (Level 0) + 040 (screen_facts). Idempotent.

DROP FUNCTION IF EXISTS screen_facts();

CREATE FUNCTION screen_facts()
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
    ret_52w           NUMERIC,
    bull              BOOLEAN,
    bear              BOOLEAN
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
             THEN (lp.close / p52.close - 1) * 100 END,
        CASE WHEN left(c.bull_eval, 1) = '✅' THEN true
             WHEN left(c.bull_eval, 1) = '❌' THEN false END,
        CASE WHEN left(c.bear_eval, 1) = '✅' THEN true
             WHEN left(c.bear_eval, 1) = '❌' THEN false END
    FROM securities s
    -- INNER: only tickers we can actually score (have fundamentals).
    JOIN LATERAL (
        SELECT * FROM fundamentals fd
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
        SELECT * FROM valuation vl
        WHERE vl.ticker = s.ticker ORDER BY vl.date DESC LIMIT 1
    ) v ON true
    LEFT JOIN companies c ON c.ticker = s.ticker
    WHERE s.is_tier1 AND s.status = 'active';
$$;
