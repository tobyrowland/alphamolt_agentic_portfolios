-- Migration 056: feed the research card's quality_score into the screener.
--
-- The screener composite currently uses only Q/V/M × a binary bull/bear
-- multiplier. The research card (migration 055) carries a 1-5 quality_score per
-- equity (moat/durability/earnings-quality/balance-sheet, computed once + shared
-- + verified-data-gated). Expose it to the screener so high-quality businesses
-- rank higher — the scorers apply a gentle ±20% multiplier (screen.py /
-- web/lib/screen/score.ts), neutral when a name has no card.
--
-- Two read paths need it:
--   * screen_ai_overlay()  — the Python buyer reads this (fast; applied by MCP).
--   * screen_facts_mv      — the web /screener reads this (heavy rebuild → run in
--                            the Supabase SQL editor; the MCP gateway times out
--                            on the ~3k-LATERAL-join rebuild).
-- The matview rebuild also repoints its bull/bear join companies -> ai_analysis,
-- finishing migration 053's deferred Stage-A1 step. Non-regressive (ai_analysis
-- bull/bear were seeded from companies). Additive & idempotent.

-- ---- screen_ai_overlay(): add quality_score, read from ai_analysis ----------
-- DROP first: the return type changes (new quality_score column), which
-- CREATE OR REPLACE can't do.
DROP FUNCTION IF EXISTS screen_ai_overlay();
CREATE OR REPLACE FUNCTION screen_ai_overlay()
RETURNS TABLE (ticker TEXT, bull BOOLEAN, bear BOOLEAN, quality_score INT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT ticker,
    CASE WHEN left(bull_eval,1)='✅' THEN true WHEN left(bull_eval,1)='❌' THEN false END,
    CASE WHEN left(bear_eval,1)='✅' THEN true WHEN left(bear_eval,1)='❌' THEN false END,
    (research_card->>'quality_score')::int
  FROM ai_analysis
  WHERE bull_eval IS NOT NULL OR bear_eval IS NOT NULL OR research_card IS NOT NULL;
$$;

-- ---- screen_facts_mv: add quality_score column (+ bull/bear from ai_analysis) -
-- Same body as migration 053, with the AI join carrying quality_score too.
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
             WHEN left(a.bear_eval, 1) = '❌' THEN false END AS bear,
        (a.research_card->>'quality_score')::int AS quality_score
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
