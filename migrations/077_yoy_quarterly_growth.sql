-- Migration 077: revenue growth measured YoY-per-quarter, not sequentially.
--
-- The 074/075 revenue-inflection facts were built on SEQUENTIAL
-- quarter-over-quarter growth (rev[i] vs rev[i+1]) — which reads seasonality
-- as signal: a retailer "accelerates" every Q4 and "decelerates" every Q1
-- regardless of trend. The correct basis for both the growth filter and the
-- inflection signal is the YoY quarterly read: each quarter vs the SAME
-- quarter last year.
--
-- New write-time facts (eodhd_updater.compute_inflection):
--   rev_growth_yoy_q    — latest quarter's revenue vs the year-ago quarter, %
--   rev_yoy_accel       — change in that YoY growth vs the prior quarter's, pp
--   rev_yoy_accel_qtrs  — consecutive quarters of improving YoY growth
-- plus a `rev_growth_yoy` series inside fundamentals.quarterly_metrics (so
-- the 076 filter transforms — streaks/slopes/percentiles — work over it too).
--
-- `inflection_signals` and the Inflection lens now use the YoY family; the
-- sequential columns (rev_growth_qoq / rev_qoq_accel / rev_accel_qtrs) stay
-- populated and filterable so saved configs keep working, but they leave the
-- friendly filter menu.
--
-- Coverage: populates on the daily fundamentals rotation — run
-- `python fundamentals_updater.py --batch 4000` once for a same-day backfill.
--
-- Heavy rebuild: run in the Supabase SQL editor, then
-- `SELECT refresh_screen_facts();`. Same body as migration 076 plus the three
-- new columns.

-- ---- 1. fundamentals: the YoY quarterly growth family ----------------------
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS rev_growth_yoy_q    NUMERIC;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS rev_yoy_accel       NUMERIC;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS rev_yoy_accel_qtrs  NUMERIC;

-- fundamentals.quarterly_metrics — defined by migration 076 but (like 058's
-- ps_trend_pct before it) never applied to the live DB; the matview below
-- reads it, so create it if it's still missing. Populates on the fundamentals
-- rotation / backfill.
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS quarterly_metrics JSONB;

-- ---- 2. screen_facts_mv ----------------------------------------------------
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
        f.rev_growth_qoq,
        f.rev_growth_yoy_q,
        f.gross_margin,
        f.fcf_margin,
        f.net_margin,
        f.operating_margin,
        f.rule_of_40,
        f.gm_delta_qoq,
        f.gm_expansion_qtrs,
        f.rev_qoq_accel,
        f.rev_accel_qtrs,
        f.rev_yoy_accel,
        f.rev_yoy_accel_qtrs,
        f.fcf_delta_qoq,
        f.fcf_improving_qtrs,
        f.inflection_signals,
        f.net_debt_ebitda,
        f.interest_coverage,
        f.quarterly_metrics AS quarters,
        v.ps,
        v.ps_median_12m,
        v.ps_trend_pct,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END AS ret_52w,
        CASE WHEN px.high_52w IS NOT NULL AND px.high_52w > 0 AND lp.close IS NOT NULL
             THEN (1 - lp.close / px.high_52w) * 100 END AS drawdown_52w,
        CASE WHEN px.low_26w IS NOT NULL AND px.low_26w > 0 AND lp.close IS NOT NULL
             THEN (lp.close / px.low_26w - 1) * 100 END AS above_low_26w,
        CASE WHEN v.ps IS NOT NULL AND v.ps_median_12m > 0
             THEN (v.ps / v.ps_median_12m - 1) * 100 END AS ps_vs_median,
        CASE WHEN left(a.bull_eval, 1) = '✅' THEN true
             WHEN left(a.bull_eval, 1) = '❌' THEN false END AS bull,
        CASE WHEN left(a.bear_eval, 1) = '✅' THEN true
             WHEN left(a.bear_eval, 1) = '❌' THEN false END AS bear,
        a.bull_score,
        a.bear_score,
        (a.research_card->>'quality_score')::int                       AS quality_score,
        (a.research_card->'moat'->>'score')::int                       AS moat_score,
        (a.research_card->'earnings_quality'->>'score')::int           AS earnings_score,
        (a.research_card->'growth_durability'->>'score')::int          AS growth_score,
        COALESCE(jsonb_array_length(a.research_card->'break_signals'), 0) AS break_count,
        (a.research_card IS NOT NULL)                                  AS has_card,
        a.research_card                                                AS research_card
    FROM securities s
    JOIN LATERAL (
        SELECT rev_growth_ttm, rev_growth_qoq, rev_growth_yoy_q, gross_margin,
               fcf_margin, net_margin, operating_margin, rule_of_40,
               gm_delta_qoq, gm_expansion_qtrs, rev_qoq_accel, rev_accel_qtrs,
               rev_yoy_accel, rev_yoy_accel_qtrs,
               fcf_delta_qoq, fcf_improving_qtrs, inflection_signals,
               net_debt_ebitda, interest_coverage, quarterly_metrics
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
        SELECT max(pd.close) AS high_52w,
               min(pd.close) FILTER (
                   WHERE pd.date >= CURRENT_DATE - INTERVAL '26 weeks') AS low_26w
        FROM prices_daily pd
        WHERE pd.ticker = s.ticker
          AND pd.date >= CURRENT_DATE - INTERVAL '52 weeks'
          AND pd.close > 0
    ) px ON true
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
    b.rev_growth_ttm, b.rev_growth_qoq, b.rev_growth_yoy_q, b.gross_margin,
    b.fcf_margin, b.net_margin, b.operating_margin, b.rule_of_40, b.ps,
    b.ps_median_12m, b.ps_trend_pct,
    b.ret_52w, b.drawdown_52w, b.above_low_26w, b.ps_vs_median,
    b.gm_delta_qoq, b.gm_expansion_qtrs, b.rev_qoq_accel, b.rev_accel_qtrs,
    b.rev_yoy_accel, b.rev_yoy_accel_qtrs,
    b.fcf_delta_qoq, b.fcf_improving_qtrs, b.inflection_signals,
    b.net_debt_ebitda, b.interest_coverage, b.quarters,
    b.bull, b.bear, b.bull_score, b.bear_score, b.quality_score,
    b.moat_score, b.earnings_score, b.growth_score, b.break_count, b.has_card,
    b.research_card,
    ind.ps_med AS industry_ps_median,
    sec.ps_med AS sector_ps_median,
    CASE WHEN ind.n >= 5 THEN ind.ps_med ELSE sec.ps_med END AS peer_ps_median,
    CASE WHEN ind.n >= 5 THEN 'industry' ELSE 'sector' END    AS peer_basis
FROM base b
LEFT JOIN ind_stats ind ON ind.industry = b.industry
LEFT JOIN sec_stats sec ON sec.sector  = b.sector;

CREATE UNIQUE INDEX IF NOT EXISTS screen_facts_mv_ticker ON screen_facts_mv (ticker);
GRANT SELECT ON screen_facts_mv TO anon, authenticated, service_role;

-- ---- 3. screen_facts() -----------------------------------------------------
DROP FUNCTION IF EXISTS screen_facts();
CREATE OR REPLACE FUNCTION public.screen_facts()
RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric,
    rev_growth_qoq numeric, rev_growth_yoy_q numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric,
    rule_of_40 numeric, ps numeric, ps_median_12m numeric, ps_trend_pct numeric,
    ret_52w numeric, drawdown_52w numeric, above_low_26w numeric,
    ps_vs_median numeric, gm_delta_qoq numeric, gm_expansion_qtrs numeric,
    rev_qoq_accel numeric, rev_accel_qtrs numeric,
    rev_yoy_accel numeric, rev_yoy_accel_qtrs numeric, fcf_delta_qoq numeric,
    fcf_improving_qtrs numeric, inflection_signals numeric,
    net_debt_ebitda numeric, interest_coverage numeric, quarters jsonb,
    bull boolean, bear boolean, bull_score int, bear_score int, quality_score int,
    moat_score int, earnings_score int, growth_score int, break_count int,
    has_card boolean, research_card jsonb, industry_ps_median numeric,
    sector_ps_median numeric, peer_ps_median numeric, peer_basis text)
LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, rev_growth_qoq, rev_growth_yoy_q, gross_margin,
           fcf_margin, net_margin, operating_margin, rule_of_40, ps,
           ps_median_12m, ps_trend_pct,
           ret_52w, drawdown_52w, above_low_26w, ps_vs_median,
           gm_delta_qoq, gm_expansion_qtrs, rev_qoq_accel, rev_accel_qtrs,
           rev_yoy_accel, rev_yoy_accel_qtrs,
           fcf_delta_qoq, fcf_improving_qtrs, inflection_signals,
           net_debt_ebitda, interest_coverage, quarters,
           bull, bear, bull_score, bear_score, quality_score,
           moat_score, earnings_score, growth_score, break_count, has_card,
           research_card, industry_ps_median, sector_ps_median, peer_ps_median,
           peer_basis
    FROM screen_facts_mv;
$function$;

-- screen_ai_overlay() is unchanged (066's definition stands).
