-- Migration 066: graded bull/bear scores feed the screener (verdict_z).
--
-- The screener score moves from `final_z = base_z + adj_z` to
-- `final_z = base_z + adj_z + verdict_z`, where verdict_z is a GENTLE (±0.3σ)
-- additive tilt from the adversarial bull (Claude) + bear (Gemini) verdicts —
-- an independent signal vs the Gemini research card (which drives adj_z). The
-- scoring math lives in screen.py + web/lib/screen/score.ts; this migration ships
-- only the DATA those scorers read.
--
-- verdict_evaluation.py now writes a graded 1-5 conviction per side:
--   ai_analysis.bull_score  1-5  (5 = strongest bull case)
--   ai_analysis.bear_score  1-5  (5 = strongest bear / red-flag case)
-- Both are nullable; a name with either NULL gets verdict_z = 0 (neutral — same
-- "no penalty for unevaluated" rule as the research card). They co-arrive (one
-- shared verdict pass), and backfill over a ~10-day rotation, so the screener is
-- unchanged until the scores populate, then turns on gradually.
--
-- Three additive / non-regressive changes:
--   1. ai_analysis    — add bull_score / bear_score.
--   2. screen_facts_mv — surface both (display + the web scorer reads the matview).
--   3. screen_facts() / screen_ai_overlay() — surface both to the web RPC + the
--      Python buyer overlay (so screen.py scores the same verdict_z, no matview
--      wait).
--
-- Heavy rebuild: run in the Supabase SQL editor (the MCP gateway times out on the
-- ~3k-LATERAL-join matview rebuild). Run a `verdict-evaluation` pass afterwards to
-- populate the new scores, then `refresh_screen_facts()` (mig 065 raised its
-- statement_timeout so the CONCURRENTLY refresh no longer times out).

-- ---- 1. ai_analysis: graded verdict scores --------------------------------
ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS bull_score INT;
ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS bear_score INT;

-- ---- 2. screen_facts_mv: add bull_score / bear_score ----------------------
-- Same body as migration 057, plus the two graded scores from ai_analysis.
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
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END AS ret_52w,
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
    b.operating_margin, b.rule_of_40, b.ps, b.ps_median_12m, b.ret_52w,
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

-- ---- 3a. screen_facts(): surface bull_score / bear_score to the web --------
DROP FUNCTION IF EXISTS screen_facts();
CREATE OR REPLACE FUNCTION public.screen_facts()
RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric,
    rule_of_40 numeric, ps numeric, ps_median_12m numeric, ret_52w numeric,
    bull boolean, bear boolean, bull_score int, bear_score int, quality_score int,
    moat_score int, earnings_score int, growth_score int, break_count int,
    has_card boolean, research_card jsonb, industry_ps_median numeric,
    sector_ps_median numeric, peer_ps_median numeric, peer_basis text)
LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, gross_margin, fcf_margin, net_margin, operating_margin,
           rule_of_40, ps, ps_median_12m, ret_52w, bull, bear,
           bull_score, bear_score, quality_score,
           moat_score, earnings_score, growth_score, break_count, has_card,
           research_card, industry_ps_median, sector_ps_median, peer_ps_median,
           peer_basis
    FROM screen_facts_mv;
$function$;

-- ---- 3b. screen_ai_overlay(): add bull_score / bear_score for the buyer ----
DROP FUNCTION IF EXISTS screen_ai_overlay();
CREATE OR REPLACE FUNCTION screen_ai_overlay()
RETURNS TABLE (ticker TEXT, bull BOOLEAN, bear BOOLEAN,
    bull_score INT, bear_score INT, quality_score INT,
    moat_score INT, earnings_score INT, growth_score INT, break_count INT,
    has_card BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT ticker,
    CASE WHEN left(bull_eval,1)='✅' THEN true WHEN left(bull_eval,1)='❌' THEN false END,
    CASE WHEN left(bear_eval,1)='✅' THEN true WHEN left(bear_eval,1)='❌' THEN false END,
    bull_score,
    bear_score,
    (research_card->>'quality_score')::int,
    (research_card->'moat'->>'score')::int,
    (research_card->'earnings_quality'->>'score')::int,
    (research_card->'growth_durability'->>'score')::int,
    COALESCE(jsonb_array_length(research_card->'break_signals'), 0),
    (research_card IS NOT NULL)
  FROM ai_analysis
  WHERE bull_eval IS NOT NULL OR bear_eval IS NOT NULL OR research_card IS NOT NULL
     OR bull_score IS NOT NULL OR bear_score IS NOT NULL;
$$;
