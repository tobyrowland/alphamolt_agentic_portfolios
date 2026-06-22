-- Migration 058: valuation trend (direction of the P/S multiple) + peer P/S
-- into scoring.
--
-- Two valuation upgrades (screener + buyer):
--   1. Sector-relative P/S — `peer_ps_median` already lives on screen_facts_mv
--      (migration 057, display-only). The scorers (screen.py / score.ts) now
--      BLEND it into the Value lens, so no new column is needed for that half.
--   2. Valuation DIRECTION — a new precomputed `valuation.ps_trend_pct`: the %
--      change of the P/S multiple over a trailing quarter, derived from the
--      existing `valuation.history_json` series by backfill_tier1_valuation.py.
--      >0 ⇒ the multiple is expanding (re-rating up); <0 ⇒ compressing.
--
-- This migration ships the DATA: the new column + surfacing it through the
-- screen_facts_mv matview and the screen_facts() RPC so the web (RPC) and the
-- Python buyer (same RPC rows) both receive it. Direction is consumed by the
-- LLM buyer + the screener display, NOT the deterministic score (kept out to
-- avoid double-counting Momentum).
--
-- Heavy rebuild: run in the Supabase SQL editor (the MCP gateway times out on
-- the ~3k-LATERAL-join matview rebuild). Re-run backfill_tier1_valuation.py
-- afterwards to populate ps_trend_pct on existing valuation rows.

-- ---- 1. new column --------------------------------------------------------
ALTER TABLE valuation ADD COLUMN IF NOT EXISTS ps_trend_pct numeric;
COMMENT ON COLUMN valuation.ps_trend_pct IS
    'Trailing-quarter % change of the P/S multiple (derived from history_json). '
    '>0 = multiple expanding (re-rating up); <0 = compressing (de-rating).';

-- ---- 2. screen_facts_mv: carry ps_trend_pct through -----------------------
-- Identical body to migration 057, with v.ps_trend_pct added to the valuation
-- LATERAL and the final projection.
DROP MATERIALIZED VIEW IF EXISTS screen_facts_mv;
CREATE MATERIALIZED VIEW screen_facts_mv AS
WITH base AS (
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
        v.ps_trend_pct,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END AS ret_52w,
        CASE WHEN left(a.bull_eval, 1) = '✅' THEN true
             WHEN left(a.bull_eval, 1) = '❌' THEN false END AS bull,
        CASE WHEN left(a.bear_eval, 1) = '✅' THEN true
             WHEN left(a.bear_eval, 1) = '❌' THEN false END AS bear,
        (a.research_card->>'quality_score')::int                       AS quality_score,
        (a.research_card->'moat'->>'score')::int                       AS moat_score,
        (a.research_card->'earnings_quality'->>'score')::int           AS earnings_score,
        (a.research_card->'growth_durability'->>'score')::int          AS growth_score,
        COALESCE(jsonb_array_length(a.research_card->'break_signals'), 0) AS break_count,
        (a.research_card IS NOT NULL)                                  AS has_card,
        a.research_card                                                AS research_card
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
        SELECT ps, ps_median_12m, ps_trend_pct FROM valuation vl
        WHERE vl.ticker = s.ticker ORDER BY vl.date DESC LIMIT 1
    ) v ON true
    LEFT JOIN ai_analysis a ON a.ticker = s.ticker
    WHERE s.is_tier1 AND s.status = 'active'
),
ind_stats AS (
    SELECT industry,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ps) AS ps_med,
           count(*) FILTER (WHERE ps IS NOT NULL AND ps > 0) AS n
    FROM base WHERE industry IS NOT NULL GROUP BY industry
),
sec_stats AS (
    SELECT sector,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ps) AS ps_med
    FROM base WHERE sector IS NOT NULL GROUP BY sector
)
SELECT
    b.ticker, b.name, b.sector, b.industry, b.country, b.price, b.price_asof,
    b.rev_growth_ttm, b.gross_margin, b.fcf_margin, b.net_margin,
    b.operating_margin, b.rule_of_40, b.ps, b.ps_median_12m, b.ps_trend_pct,
    b.ret_52w,
    b.bull, b.bear, b.quality_score,
    b.moat_score, b.earnings_score, b.growth_score, b.break_count, b.has_card,
    b.research_card,
    ind.ps_med AS industry_ps_median,
    sec.ps_med AS sector_ps_median,
    -- industry median when the industry has ≥ 5 priced peers, else sector median
    CASE WHEN ind.n >= 5 THEN ind.ps_med ELSE sec.ps_med END AS peer_ps_median,
    CASE WHEN ind.n >= 5 THEN 'industry' ELSE 'sector' END    AS peer_basis
FROM base b
LEFT JOIN ind_stats ind ON ind.industry = b.industry
LEFT JOIN sec_stats sec ON sec.sector  = b.sector;

CREATE UNIQUE INDEX IF NOT EXISTS screen_facts_mv_ticker ON screen_facts_mv (ticker);
GRANT SELECT ON screen_facts_mv TO anon, authenticated, service_role;

-- ---- 3. screen_facts(): surface ps_trend_pct to web + Python buyer ---------
DROP FUNCTION IF EXISTS screen_facts();
CREATE OR REPLACE FUNCTION public.screen_facts()
RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric,
    rule_of_40 numeric, ps numeric, ps_median_12m numeric, ps_trend_pct numeric,
    ret_52w numeric, bull boolean, bear boolean, quality_score int,
    moat_score int, earnings_score int, growth_score int, break_count int,
    has_card boolean, research_card jsonb, industry_ps_median numeric,
    sector_ps_median numeric, peer_ps_median numeric, peer_basis text)
LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, gross_margin, fcf_margin, net_margin, operating_margin,
           rule_of_40, ps, ps_median_12m, ps_trend_pct, ret_52w, bull, bear,
           quality_score, moat_score, earnings_score, growth_score, break_count,
           has_card, research_card, industry_ps_median, sector_ps_median,
           peer_ps_median, peer_basis
    FROM screen_facts_mv;
$function$;
