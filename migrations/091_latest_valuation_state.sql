-- 091_latest_valuation_state.sql
--
-- price_sales_updater.py stopped finishing. Every scheduled run from 2026-09-04
-- was killed by the workflow's 30-minute timeout, so the last complete pass was
-- 2026-09-03 and daily P/S coverage decayed from 2,909 names to 1,424 while the
-- Tier 1 universe stayed at ~3,051.
--
-- The cause was one read. db.get_all_valuation_latest() paginated the ENTIRE
-- valuation table 1,000 rows at a time — selecting history_json on every row —
-- purely to keep the newest row per ticker. The updater writes a new dated row
-- per ticker per day and copies the ~52-point history blob into each one, so
-- that table grows ~2,900 rows/day; by 2026-09-08 it was 218,843 rows / 211 MB.
-- The read cost ~16.5 minutes of a 30-minute budget and grew ~15s a day, which
-- is why run duration climbed 1,077s (Aug 22) → 1,629s (Sep 3) → over the cliff.
--
-- This is the same lesson as migration 044, which narrowed screen_facts_mv's
-- LATERAL subqueries off `SELECT *` precisely to stop "dragging the big
-- valuation.history_json JSONB for every ticker". That reader never got the
-- same treatment.
--
-- latest_valuation_state() does the reduction server-side: DISTINCT ON (ticker)
-- over the PK's (ticker, date) btree returns ~3,500 rows instead of ~219,000,
-- so the client transfers one history blob per ticker rather than one per
-- ticker per day. The Python caller keeps a paginating fallback for the window
-- between deploying the code and applying this migration.

CREATE OR REPLACE FUNCTION public.latest_valuation_state()
RETURNS TABLE (
    ticker        TEXT,
    date          DATE,
    ps            NUMERIC,
    ps_ath        NUMERIC,
    history_json  JSONB
)
LANGUAGE sql
STABLE
AS $$
    SELECT DISTINCT ON (v.ticker)
           v.ticker, v.date, v.ps, v.ps_ath, v.history_json
    FROM valuation v
    ORDER BY v.ticker, v.date DESC;
$$;

GRANT EXECUTE ON FUNCTION public.latest_valuation_state() TO service_role;
