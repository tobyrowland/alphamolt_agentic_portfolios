-- 043_api_universe_facts.sql
--
-- Level 0-backed read for the public REST API (/api/v1/equities + /equities/{ticker})
-- and the MCP equity tools. The legacy endpoints read the curated `companies`
-- table (~1k growth-screen names, mega-caps excluded by the TradingView screen),
-- which is why NVDA/AAPL/MSFT 404 and the count is capped near 1,029. This RPC
-- exposes the real universe the screener UI uses: every active Tier 1 security
-- (~3.2k liquid US equities incl. mega-caps) with its latest fundamentals /
-- valuation / price folded in.
--
-- Modelled on screen_facts() (migration 042) but:
--   * LEFT JOIN fundamentals/valuation (not INNER) so the FULL Tier 1 set comes
--     back — a name with prices but not-yet-backfilled fundamentals still lists,
--     just with null metrics.
--   * adds identity columns (exchange, security_type, status, ipo_date).
--   * output columns named to match the legacy `companies` field names where they
--     map (company_name, sector, ps_now, rev_growth_ttm_pct, gross_margin_pct, …)
--     so existing REST clients keep parsing, now over the full universe.

CREATE OR REPLACE FUNCTION public.api_universe_facts()
RETURNS TABLE(
  ticker text, company_name text, exchange text, security_type text,
  sector text, industry text, country text, status text, ipo_date date,
  is_tier1 boolean,
  price numeric, price_asof date,
  rev_growth_ttm_pct numeric, rev_growth_qoq_pct numeric, rev_cagr_pct numeric,
  gross_margin_pct numeric, operating_margin_pct numeric, net_margin_pct numeric,
  fcf_margin_pct numeric, rule_of_40 numeric, eps_only numeric,
  fundamentals_asof date,
  ps_now numeric, ps_median_12m numeric, ps_high_52w numeric, ps_low_52w numeric,
  ps_pct_of_ath numeric, valuation_asof date,
  ret_52w numeric, bull boolean, bear boolean
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        s.ticker,
        s.name,
        s.exchange,
        s.security_type,
        s.gics_sector,
        s.gics_industry,
        s.country,
        s.status,
        s.ipo_date,
        s.is_tier1,
        lp.close,
        lp.date,
        f.rev_growth_ttm,
        f.rev_growth_qoq,
        f.rev_cagr,
        f.gross_margin,
        f.operating_margin,
        f.net_margin,
        f.fcf_margin,
        f.rule_of_40,
        f.eps,
        f.period_end,
        v.ps,
        v.ps_median_12m,
        v.ps_high_52w,
        v.ps_low_52w,
        v.ps_pct_of_ath,
        v.date,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END,
        CASE WHEN left(c.bull_eval, 1) = '✅' THEN true
             WHEN left(c.bull_eval, 1) = '❌' THEN false END,
        CASE WHEN left(c.bear_eval, 1) = '✅' THEN true
             WHEN left(c.bear_eval, 1) = '❌' THEN false END
    FROM securities s
    LEFT JOIN LATERAL (
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
    WHERE s.is_tier1 AND s.status = 'active'
    ORDER BY s.ticker;
$function$;

GRANT EXECUTE ON FUNCTION public.api_universe_facts() TO anon, authenticated, service_role;
