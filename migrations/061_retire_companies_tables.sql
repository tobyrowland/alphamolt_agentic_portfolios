-- Migration 061: retire companies + price_sales (companies retirement, final phase).
--
-- APPLY LAST. Only after migrations 058-060 are applied AND the code that reads
-- Level 0 instead of companies/price_sales is deployed (this PR). Once applied,
-- nothing in the app reads or writes companies / price_sales.
--
-- Reversible-by-design: the tables are RENAMED to *_legacy, not dropped, so the
-- data survives and a rollback is `ALTER TABLE ... RENAME` back. A later trivial
-- migration can DROP them once you're satisfied.

-- 1. Repoint the last function off companies: api_universe_facts() joined
--    companies only for bull_eval/bear_eval, which now live in ai_analysis
--    (migration 053). Everything else in it is already Level 0.
CREATE OR REPLACE FUNCTION public.api_universe_facts()
 RETURNS TABLE(ticker text, company_name text, exchange text, security_type text, sector text, industry text, country text, status text, ipo_date date, is_tier1 boolean, price numeric, price_asof date, rev_growth_ttm_pct numeric, rev_growth_qoq_pct numeric, rev_cagr_pct numeric, gross_margin_pct numeric, operating_margin_pct numeric, net_margin_pct numeric, fcf_margin_pct numeric, rule_of_40 numeric, eps_only numeric, fundamentals_asof date, ps_now numeric, ps_median_12m numeric, ps_high_52w numeric, ps_low_52w numeric, ps_pct_of_ath numeric, valuation_asof date, ret_52w numeric, bull boolean, bear boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT
        s.ticker, s.name, s.exchange, s.security_type, s.gics_sector,
        s.gics_industry, s.country, s.status, s.ipo_date, s.is_tier1,
        lp.close, lp.date,
        f.rev_growth_ttm, f.rev_growth_qoq, f.rev_cagr, f.gross_margin,
        f.operating_margin, f.net_margin, f.fcf_margin, f.rule_of_40, f.eps,
        f.period_end,
        v.ps, v.ps_median_12m, v.ps_high_52w, v.ps_low_52w, v.ps_pct_of_ath,
        v.date,
        CASE WHEN p52.close IS NOT NULL AND p52.close > 0
             THEN (lp.close / p52.close - 1) * 100 END,
        CASE WHEN left(a.bull_eval, 1) = '✅' THEN true
             WHEN left(a.bull_eval, 1) = '❌' THEN false END,
        CASE WHEN left(a.bear_eval, 1) = '✅' THEN true
             WHEN left(a.bear_eval, 1) = '❌' THEN false END
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
    LEFT JOIN ai_analysis a ON a.ticker = s.ticker
    WHERE s.is_tier1 AND s.status = 'active'
    ORDER BY s.ticker;
$function$;

-- 2. Drop the price_sales -> companies FK (its parent is going away).
ALTER TABLE price_sales DROP CONSTRAINT IF EXISTS price_sales_ticker_fkey;

-- 3. Rename the legacy tables out of the way (reversible). Single source of
--    truth = Level 0 from here on.
ALTER TABLE IF EXISTS companies   RENAME TO companies_legacy;
ALTER TABLE IF EXISTS price_sales RENAME TO price_sales_legacy;
