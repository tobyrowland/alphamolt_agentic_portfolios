-- 044_screen_facts_materialized.sql
--
-- The screener got slow once the Tier 1 universe tripled (fundamentals backfill):
-- screen_facts() went from ~900 rows / sub-second to ~3,150 rows / ~7s, and
-- web/lib/screen/query.ts paginates it (re-running the whole function per page).
--
-- Two fixes here:
--   1. The LATERAL subqueries did `SELECT *`, dragging the big valuation.history_json
--      JSONB for every ticker though only ps/ps_median_12m are used. Narrowing the
--      column lists alone cut the query ~7.2s → ~1.7s.
--   2. Materialize it. The facts change only on the daily/filing cadence, so we
--      compute the ~3k-row set once into screen_facts_mv and read that. Page loads
--      become a cheap indexed table scan (~tens of ms) instead of recomputing 3k
--      per-ticker LATERAL lookups on every request/page.
--
-- screen_facts() is redefined to read the matview, so every existing caller
-- (the TS loader + the Python screen.py RPC) gets the speedup transparently.
-- refresh_screen_facts() rebuilds the matview; the daily Level 0 price job calls
-- it after writing fresh prices.

CREATE MATERIALIZED VIEW IF NOT EXISTS screen_facts_mv AS
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
        CASE WHEN left(c.bull_eval, 1) = '✅' THEN true
             WHEN left(c.bull_eval, 1) = '❌' THEN false END AS bull,
        CASE WHEN left(c.bear_eval, 1) = '✅' THEN true
             WHEN left(c.bear_eval, 1) = '❌' THEN false END AS bear
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
    LEFT JOIN companies c ON c.ticker = s.ticker
    WHERE s.is_tier1 AND s.status = 'active';

-- Unique index is required for REFRESH ... CONCURRENTLY (non-blocking refresh).
CREATE UNIQUE INDEX IF NOT EXISTS screen_facts_mv_ticker ON screen_facts_mv (ticker);

GRANT SELECT ON screen_facts_mv TO anon, authenticated, service_role;

-- Redefine screen_facts() to read the matview — fast, and keeps every existing
-- caller working unchanged (same column set + order).
CREATE OR REPLACE FUNCTION public.screen_facts()
RETURNS TABLE(ticker text, name text, sector text, industry text, country text,
    price numeric, price_asof date, rev_growth_ttm numeric, gross_margin numeric,
    fcf_margin numeric, net_margin numeric, operating_margin numeric,
    rule_of_40 numeric, ps numeric, ps_median_12m numeric, ret_52w numeric,
    bull boolean, bear boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT ticker, name, sector, industry, country, price, price_asof,
           rev_growth_ttm, gross_margin, fcf_margin, net_margin, operating_margin,
           rule_of_40, ps, ps_median_12m, ret_52w, bull, bear
    FROM screen_facts_mv;
$function$;

-- Refresh helper — called by the daily Level 0 price job after it writes prices.
CREATE OR REPLACE FUNCTION public.refresh_screen_facts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY screen_facts_mv;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refresh_screen_facts() TO service_role;
