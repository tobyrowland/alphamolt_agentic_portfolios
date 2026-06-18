-- Migration 057: screener single-score redesign — data layer.
--
-- The screener moves from a 0–100 composite × hidden ±20% multipliers to ONE
-- ordering score: final_z = base_z + adj_z, displayed as a universe percentile
-- round(Φ(final_z)·100). See the screener redesign brief (§2). This migration
-- ships only the DATA the two scorers (web/lib/screen/score.ts + screen.py) read;
-- the scoring math lives in those modules and reads the constants below.
--
-- Three additions, all additive / non-regressive:
--   1. screen_facts_mv  — per-row research-card scalars (moat/earnings/growth
--      score + break-signal count) extracted from ai_analysis.research_card, and
--      peer (industry/sector) median P/S (display-only this task — brief §5).
--   2. screen_lens_stats — a tiny table (precedent: metric_stats, mig 038) holding
--      the universe μ/σ of each raw lens value. Populated by
--      screen.compute_lens_stats() in the daily prices job; both scorers read it
--      so the cross-sectional z-scores are computed against the same moments.
--   3. screen_facts() / screen_ai_overlay() — surface the new matview columns so
--      the web (RPC) and the Python buyer (overlay) both get them.
--
-- Heavy rebuild: run in the Supabase SQL editor (the MCP gateway times out on the
-- ~3k-LATERAL-join matview rebuild). Run a `prices-daily` job afterwards (or call
-- screen.compute_lens_stats) to populate screen_lens_stats + the new columns.

-- ---- 1. screen_lens_stats -------------------------------------------------
CREATE TABLE IF NOT EXISTS screen_lens_stats (
    lens        TEXT PRIMARY KEY,           -- 'quality' | 'value' | 'momentum'
    mu          DOUBLE PRECISION NOT NULL,  -- universe mean of the raw lens value
    sigma       DOUBLE PRECISION NOT NULL,  -- universe stdev (population)
    n           INTEGER NOT NULL,           -- count of scoreable names
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE screen_lens_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS screen_lens_stats_public_read ON screen_lens_stats;
CREATE POLICY screen_lens_stats_public_read ON screen_lens_stats
    FOR SELECT USING (true);
GRANT SELECT ON screen_lens_stats TO anon, authenticated, service_role;

-- ---- 2. screen_facts_mv: research-card scalars + peer median P/S ----------
-- Same per-ticker body as migration 056, wrapped so an outer pass can compute
-- industry/sector median P/S (ordered-set aggregate → can't be a window fn, so
-- medians are grouped in CTEs and joined back). peer_ps_median uses the industry
-- median when the industry has enough priced peers, else the sector median.
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
        (a.research_card->>'quality_score')::int                       AS quality_score,
        (a.research_card->'moat'->>'score')::int                       AS moat_score,
        (a.research_card->'earnings_quality'->>'score')::int           AS earnings_score,
        (a.research_card->'growth_durability'->>'score')::int          AS growth_score,
        COALESCE(jsonb_array_length(a.research_card->'break_signals'), 0) AS break_count,
        (a.research_card IS NOT NULL)                                  AS has_card,
        -- Full card JSON so the page compiles thesis / dim rationale+evidence /
        -- break descriptions from stored copy (brief §7 — compile, don't
        -- generate). ~3% of rows carry one, so the payload stays light.
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

-- ---- 3a. screen_facts(): surface the new columns to the web ---------------
-- The web reads facts through this RPC, so it must expose quality_score (latent
-- gap since mig 056), the research-card scalars, and the peer-median columns.
DROP FUNCTION IF EXISTS screen_facts();
CREATE OR REPLACE FUNCTION public.screen_facts()
RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric,
    rule_of_40 numeric, ps numeric, ps_median_12m numeric, ret_52w numeric,
    bull boolean, bear boolean, quality_score int,
    moat_score int, earnings_score int, growth_score int, break_count int,
    has_card boolean, research_card jsonb, industry_ps_median numeric,
    sector_ps_median numeric, peer_ps_median numeric, peer_basis text)
LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, gross_margin, fcf_margin, net_margin, operating_margin,
           rule_of_40, ps, ps_median_12m, ret_52w, bull, bear, quality_score,
           moat_score, earnings_score, growth_score, break_count, has_card,
           research_card, industry_ps_median, sector_ps_median, peer_ps_median,
           peer_basis
    FROM screen_facts_mv;
$function$;

-- ---- 3b. screen_ai_overlay(): add research-card scalars for the buyer ------
-- The Python buyer reads bull/bear/quality off this overlay (no matview wait);
-- give it the moat/earnings/growth scores + break count so screen.py computes
-- the same adj_z without the matview.
DROP FUNCTION IF EXISTS screen_ai_overlay();
CREATE OR REPLACE FUNCTION screen_ai_overlay()
RETURNS TABLE (ticker TEXT, bull BOOLEAN, bear BOOLEAN, quality_score INT,
    moat_score INT, earnings_score INT, growth_score INT, break_count INT,
    has_card BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT ticker,
    CASE WHEN left(bull_eval,1)='✅' THEN true WHEN left(bull_eval,1)='❌' THEN false END,
    CASE WHEN left(bear_eval,1)='✅' THEN true WHEN left(bear_eval,1)='❌' THEN false END,
    (research_card->>'quality_score')::int,
    (research_card->'moat'->>'score')::int,
    (research_card->'earnings_quality'->>'score')::int,
    (research_card->'growth_durability'->>'score')::int,
    COALESCE(jsonb_array_length(research_card->'break_signals'), 0),
    (research_card IS NOT NULL)
  FROM ai_analysis
  WHERE bull_eval IS NOT NULL OR bear_eval IS NOT NULL OR research_card IS NOT NULL;
$$;
