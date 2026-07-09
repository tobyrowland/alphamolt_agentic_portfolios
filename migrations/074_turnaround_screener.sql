-- Migration 074: turnaround screener facts — washout / inflection / survivability.
--
-- The turnaround strategy needs three gates the screener couldn't express:
--   1. WASHOUT  — price 40–70% off its 52-week high but already off its
--      3–6-month low (base forming, not still knife-ing), and P/S below the
--      name's own median. All price-structure facts, computed here from
--      prices_daily / the latest valuation row.
--   2. INFLECTION — two consecutive quarters of gross margin expanding, QoQ
--      revenue growth improving, or FCF margin trending toward breakeven.
--      Quarter-over-quarter facts computed at WRITE time by eodhd_updater
--      (fundamentals has no per-quarter history — rows are latest-snapshot),
--      stored on the latest fundamentals row and surfaced here.
--   3. SURVIVABILITY — net debt / EBITDA and interest coverage, extracted from
--      EODHD balance-sheet + income statements by eodhd_updater. Hard-filter
--      material, never scored.
--
-- These are FACTS (deterministic derivations of raw statements/prices), not
-- strategy — the strategy lives in the new `turnaround` preset's filters +
-- weights (web/lib/screen/config.ts). Level 0 stays neutral.
--
-- Also fixes a mig-066 regression: 066 rebuilt the matview from 057's body,
-- silently dropping `ps_trend_pct` (added by 058) — the web loader has been
-- reading it as NULL since. Restored below. The `valuation.ps_trend_pct`
-- column itself is created defensively here too: migration 058's ALTER was
-- never applied to the live database (which is why 066's drop went unnoticed),
-- so the first run of this migration failed on the missing column.
--
-- Coverage note: the inflection/survivability columns populate on the daily
-- fundamentals rotation (fundamentals_updater.py, 150 stalest/run) — run
-- `python fundamentals_updater.py --batch 4000` once to backfill the whole
-- Tier-1 universe in a day. The price-structure columns (drawdown_52w,
-- above_low_26w, ps_vs_median) have full coverage from the first refresh.
--
-- Heavy rebuild: run in the Supabase SQL editor (the MCP gateway times out on
-- the ~3k-LATERAL-join matview rebuild). Then `refresh_screen_facts()`.

-- ---- 1. fundamentals: write-time inflection + survivability columns --------
-- (cash / debt / shares_out already exist — eodhd_updater now populates them,
-- which also un-gates the research card's balance_sheet_risk dimension.)
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS gm_delta_qoq         NUMERIC; -- latest quarterly gross margin minus prior, pp
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS gm_expansion_qtrs    NUMERIC; -- consecutive quarters of GM expansion (0 = not expanding)
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS rev_qoq_accel        NUMERIC; -- latest QoQ revenue growth minus prior QoQ growth, pp
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS rev_accel_qtrs       NUMERIC; -- consecutive quarters of improving QoQ revenue growth
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS fcf_delta_qoq        NUMERIC; -- latest quarterly FCF margin minus prior, pp
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS fcf_improving_qtrs   NUMERIC; -- consecutive quarters of improving FCF margin
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS inflection_signals   NUMERIC; -- how many of the three streaks are ≥ 2 quarters (0–3)
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS ebitda_ttm           NUMERIC;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS interest_expense_ttm NUMERIC;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS net_debt_ebitda      NUMERIC; -- (debt − cash) / TTM EBITDA; NULL when EBITDA ≤ 0
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS interest_coverage    NUMERIC; -- TTM EBIT / TTM interest; 999 = profitable + no interest

-- valuation.ps_trend_pct — defined by migration 058 but never applied to the
-- live DB; the matview below reads it, so create it if it's still missing.
-- Stays NULL until backfill_tier1_valuation.py repopulates (display-only).
ALTER TABLE valuation ADD COLUMN IF NOT EXISTS ps_trend_pct NUMERIC;

-- ---- 2. screen_facts_mv: washout facts + surface the new columns -----------
-- Same body as migration 066, plus: ps_trend_pct restored (058 regression),
-- a price-structure LATERAL (52w high / 26w low over prices_daily), the
-- ps_vs_median derivation, and the fundamentals inflection/survivability set.
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
        f.gm_delta_qoq,
        f.gm_expansion_qtrs,
        f.rev_qoq_accel,
        f.rev_accel_qtrs,
        f.fcf_delta_qoq,
        f.fcf_improving_qtrs,
        f.inflection_signals,
        f.net_debt_ebitda,
        f.interest_coverage,
        v.ps,
        v.ps_median_12m,
        v.ps_trend_pct,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END AS ret_52w,
        -- Washout structure: % below the 52-week closing high (positive =
        -- drawn down) and % above the 26-week closing low (base forming).
        CASE WHEN px.high_52w IS NOT NULL AND px.high_52w > 0 AND lp.close IS NOT NULL
             THEN (1 - lp.close / px.high_52w) * 100 END AS drawdown_52w,
        CASE WHEN px.low_26w IS NOT NULL AND px.low_26w > 0 AND lp.close IS NOT NULL
             THEN (lp.close / px.low_26w - 1) * 100 END AS above_low_26w,
        -- Cheapness vs the name's OWN 12-mo median P/S, as a signed % premium
        -- (negative = below its usual multiple).
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
        SELECT rev_growth_ttm, gross_margin, fcf_margin, net_margin,
               operating_margin, rule_of_40,
               gm_delta_qoq, gm_expansion_qtrs, rev_qoq_accel, rev_accel_qtrs,
               fcf_delta_qoq, fcf_improving_qtrs, inflection_signals,
               net_debt_ebitda, interest_coverage
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
    b.rev_growth_ttm, b.gross_margin, b.fcf_margin, b.net_margin,
    b.operating_margin, b.rule_of_40, b.ps, b.ps_median_12m, b.ps_trend_pct,
    b.ret_52w, b.drawdown_52w, b.above_low_26w, b.ps_vs_median,
    b.gm_delta_qoq, b.gm_expansion_qtrs, b.rev_qoq_accel, b.rev_accel_qtrs,
    b.fcf_delta_qoq, b.fcf_improving_qtrs, b.inflection_signals,
    b.net_debt_ebitda, b.interest_coverage,
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

-- ---- 3. screen_facts(): surface the new columns to both scorers ------------
DROP FUNCTION IF EXISTS screen_facts();
CREATE OR REPLACE FUNCTION public.screen_facts()
RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric,
    rule_of_40 numeric, ps numeric, ps_median_12m numeric, ps_trend_pct numeric,
    ret_52w numeric, drawdown_52w numeric, above_low_26w numeric,
    ps_vs_median numeric, gm_delta_qoq numeric, gm_expansion_qtrs numeric,
    rev_qoq_accel numeric, rev_accel_qtrs numeric, fcf_delta_qoq numeric,
    fcf_improving_qtrs numeric, inflection_signals numeric,
    net_debt_ebitda numeric, interest_coverage numeric,
    bull boolean, bear boolean, bull_score int, bear_score int, quality_score int,
    moat_score int, earnings_score int, growth_score int, break_count int,
    has_card boolean, research_card jsonb, industry_ps_median numeric,
    sector_ps_median numeric, peer_ps_median numeric, peer_basis text)
LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, gross_margin, fcf_margin, net_margin, operating_margin,
           rule_of_40, ps, ps_median_12m, ps_trend_pct, ret_52w,
           drawdown_52w, above_low_26w, ps_vs_median,
           gm_delta_qoq, gm_expansion_qtrs, rev_qoq_accel, rev_accel_qtrs,
           fcf_delta_qoq, fcf_improving_qtrs, inflection_signals,
           net_debt_ebitda, interest_coverage,
           bull, bear, bull_score, bear_score, quality_score,
           moat_score, earnings_score, growth_score, break_count, has_card,
           research_card, industry_ps_median, sector_ps_median, peer_ps_median,
           peer_basis
    FROM screen_facts_mv;
$function$;

-- screen_ai_overlay() is unchanged (066's definition stands): the Python buyer
-- reads the new columns straight off screen_facts() rows.
