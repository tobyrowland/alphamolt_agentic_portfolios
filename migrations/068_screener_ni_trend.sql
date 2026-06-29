-- 068_screener_ni_trend.sql
-- Net-income SUSTAINED-growth ranking signal.
--
-- Adds fundamentals.net_income_trend — a multi-year trend score computed at
-- ingest by eodhd_updater.compute_net_income_trend over the annual net-income
-- series (rewards a steady climb, downweights a collapse-then-rebuild) — and
-- threads it through the screener fact path so the scorer can apply a gentle
-- ±σ `ni_trend_z` tilt (screen.py / web/lib/screen/score.ts).
--
-- A materialized view cannot ADD COLUMN, so screen_facts_mv + the screen_facts()
-- RPC are rebuilt. They are recreated from the CURRENT (live) definition — bull/
-- bear verdict scores, research-card scalars and peer P/S medians all preserved —
-- with net_income_trend appended. Recreating from an older snapshot would silently
-- drop those columns, so keep this in sync with the live shape.
--
-- Neutral until data lands: net_income_trend is NULL for every row until a
-- fundamentals refresh (fundamentals_updater.py) repopulates it, and a NULL
-- trend yields ni_trend_z = 0 — so applying this migration changes no ranking
-- on its own.

ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS net_income_trend numeric;

-- screen_facts() reads the matview; drop it first so the matview can be replaced.
DROP FUNCTION IF EXISTS public.screen_facts();
DROP MATERIALIZED VIEW IF EXISTS screen_facts_mv;

CREATE MATERIALIZED VIEW screen_facts_mv AS
WITH base AS (
    SELECT s.ticker,
        s.name,
        s.gics_sector AS sector,
        s.gics_industry AS industry,
        s.country,
        lp.close AS price,
        lp.date AS price_asof,
        f.rev_growth_ttm,
        f.gross_margin,
        f.fcf_margin,
        f.net_margin,
        f.operating_margin,
        f.rule_of_40,
        f.net_income_trend,
        v.ps,
        v.ps_median_12m,
        CASE
            WHEN p52.close IS NOT NULL AND p52.close > 0::numeric THEN (lp.close / p52.close - 1::numeric) * 100::numeric
            ELSE NULL::numeric
        END AS ret_52w,
        CASE
            WHEN "left"(a.bull_eval, 1) = '✅'::text THEN true
            WHEN "left"(a.bull_eval, 1) = '❌'::text THEN false
            ELSE NULL::boolean
        END AS bull,
        CASE
            WHEN "left"(a.bear_eval, 1) = '✅'::text THEN true
            WHEN "left"(a.bear_eval, 1) = '❌'::text THEN false
            ELSE NULL::boolean
        END AS bear,
        a.bull_score,
        a.bear_score,
        (a.research_card ->> 'quality_score'::text)::integer AS quality_score,
        ((a.research_card -> 'moat'::text) ->> 'score'::text)::integer AS moat_score,
        ((a.research_card -> 'earnings_quality'::text) ->> 'score'::text)::integer AS earnings_score,
        ((a.research_card -> 'growth_durability'::text) ->> 'score'::text)::integer AS growth_score,
        COALESCE(jsonb_array_length(a.research_card -> 'break_signals'::text), 0) AS break_count,
        a.research_card IS NOT NULL AS has_card,
        a.research_card
       FROM securities s
         JOIN LATERAL ( SELECT fd.rev_growth_ttm,
                fd.gross_margin,
                fd.fcf_margin,
                fd.net_margin,
                fd.operating_margin,
                fd.rule_of_40,
                fd.net_income_trend
               FROM fundamentals fd
              WHERE fd.ticker = s.ticker
              ORDER BY fd.period_end DESC
             LIMIT 1) f ON true
         LEFT JOIN LATERAL ( SELECT pd.close,
                pd.date
               FROM prices_daily pd
              WHERE pd.ticker = s.ticker
              ORDER BY pd.date DESC
             LIMIT 1) lp ON true
         LEFT JOIN LATERAL ( SELECT pd.close
               FROM prices_daily pd
              WHERE pd.ticker = s.ticker AND pd.date <= (CURRENT_DATE - '364 days'::interval)
              ORDER BY pd.date DESC
             LIMIT 1) p52 ON true
         LEFT JOIN LATERAL ( SELECT vl.ps,
                vl.ps_median_12m
               FROM valuation vl
              WHERE vl.ticker = s.ticker
              ORDER BY vl.date DESC
             LIMIT 1) v ON true
         LEFT JOIN ai_analysis a ON a.ticker = s.ticker
      WHERE s.is_tier1 AND s.status = 'active'::text
), ind_stats AS (
    SELECT base.industry,
        percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (base.ps::double precision)) AS ps_med,
        count(*) FILTER (WHERE base.ps IS NOT NULL AND base.ps > 0::numeric) AS n
       FROM base
      WHERE base.industry IS NOT NULL
      GROUP BY base.industry
), sec_stats AS (
    SELECT base.sector,
        percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (base.ps::double precision)) AS ps_med
       FROM base
      WHERE base.sector IS NOT NULL
      GROUP BY base.sector
)
SELECT b.ticker,
    b.name,
    b.sector,
    b.industry,
    b.country,
    b.price,
    b.price_asof,
    b.rev_growth_ttm,
    b.gross_margin,
    b.fcf_margin,
    b.net_margin,
    b.operating_margin,
    b.rule_of_40,
    b.net_income_trend,
    b.ps,
    b.ps_median_12m,
    b.ret_52w,
    b.bull,
    b.bear,
    b.bull_score,
    b.bear_score,
    b.quality_score,
    b.moat_score,
    b.earnings_score,
    b.growth_score,
    b.break_count,
    b.has_card,
    b.research_card,
    ind.ps_med AS industry_ps_median,
    sec.ps_med AS sector_ps_median,
    CASE
        WHEN ind.n >= 5 THEN ind.ps_med
        ELSE sec.ps_med
    END AS peer_ps_median,
    CASE
        WHEN ind.n >= 5 THEN 'industry'::text
        ELSE 'sector'::text
    END AS peer_basis
   FROM base b
     LEFT JOIN ind_stats ind ON ind.industry = b.industry
     LEFT JOIN sec_stats sec ON sec.sector = b.sector;

-- unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX screen_facts_mv_ticker ON screen_facts_mv USING btree (ticker);

-- restore the live grants (DROP/CREATE drops them)
GRANT ALL ON screen_facts_mv TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.screen_facts()
 RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric, rule_of_40 numeric,
    net_income_trend numeric, ps numeric, ps_median_12m numeric, ret_52w numeric,
    bull boolean, bear boolean, bull_score integer, bear_score integer,
    quality_score integer, moat_score integer, earnings_score integer, growth_score integer,
    break_count integer, has_card boolean, research_card jsonb,
    industry_ps_median numeric, sector_ps_median numeric, peer_ps_median numeric, peer_basis text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, gross_margin, fcf_margin, net_margin, operating_margin,
           rule_of_40, net_income_trend, ps, ps_median_12m, ret_52w, bull, bear,
           bull_score, bear_score, quality_score,
           moat_score, earnings_score, growth_score, break_count, has_card,
           research_card, industry_ps_median, sector_ps_median, peer_ps_median,
           peer_basis
    FROM screen_facts_mv;
$function$;

GRANT EXECUTE ON FUNCTION public.screen_facts() TO public, anon, authenticated, service_role;
