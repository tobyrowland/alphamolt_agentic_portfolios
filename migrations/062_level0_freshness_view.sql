-- Migration 062: Level 0 freshness audit surface.
--
-- One row per active security summarising "how fresh is each fact for this
-- name", with the current share price + its as-of as the headline canary (the
-- thing that's quick to eyeball). Powers a per-ticker freshness panel on the
-- website and ad-hoc audits like:
--   SELECT * FROM level0_freshness WHERE ticker = 'NVDA';
--   SELECT count(*) FROM level0_freshness WHERE price_asof < now() - interval '2 days';
--
-- Read-only view over Level 0 fact tables (all public-read). Idempotent.

CREATE OR REPLACE VIEW level0_freshness AS
SELECT
    s.ticker,
    s.name,
    s.is_tier1,
    -- Headline canary: current price + when it was captured.
    s.price                         AS price,
    s.price_asof                    AS price_asof,
    -- Per-fact "collected at" stamps.
    lp.date                         AS prices_daily_asof,
    f.fetched_at                    AS fundamentals_asof,
    f.period_end                    AS fundamentals_period_end,
    v.fetched_at                    AS valuation_asof,
    a.analyzed_at                   AS ai_analysis_asof
FROM securities s
LEFT JOIN LATERAL (
    SELECT date FROM prices_daily pd
    WHERE pd.ticker = s.ticker ORDER BY pd.date DESC LIMIT 1
) lp ON true
LEFT JOIN LATERAL (
    SELECT fetched_at, period_end FROM fundamentals fd
    WHERE fd.ticker = s.ticker ORDER BY fd.period_end DESC LIMIT 1
) f ON true
LEFT JOIN LATERAL (
    SELECT fetched_at FROM valuation vl
    WHERE vl.ticker = s.ticker ORDER BY vl.date DESC LIMIT 1
) v ON true
LEFT JOIN ai_analysis a ON a.ticker = s.ticker
WHERE s.status = 'active';
