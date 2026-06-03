-- Migration 038: Fundamentals distribution stats (metric_stats).
--
-- Precomputed, nightly, by score_ai_analysis.py (Step 6b) so the
-- /company/{ticker} fundamentals "distribution strips" can render a
-- percentile ruler (middle-50 band + universe median + sector median +
-- the stock's dot) WITHOUT recomputing the distribution on every page
-- request. See the company-page brief §5.
--
-- One row per (metric, sector):
--   * sector = ''  → the universe-wide distribution for that metric,
--                    over companies WHERE in_tv_screen = true. This row
--                    carries the band (p25/p75), the universe median
--                    (p50), and min/max for scaling the ruler.
--   * sector = 'X' → that sector's distribution for the metric. The
--                    page reads its p50 (sector median) and maps it to a
--                    universe percentile against the '' row.
--
-- Metrics tracked (brief §5):
--   rev_growth_ttm_pct, gross_margin_pct, fcf_margin_pct,
--   rule_of_40, net_margin_pct, ps_now
--
-- Idempotent: score_ai_analysis.py upserts on (metric, sector) every
-- night, overwriting the prior day's stats.

CREATE TABLE IF NOT EXISTS metric_stats (
    metric        TEXT NOT NULL,
    -- '' is the sentinel for the universe-wide row (empty string, not
    -- NULL, so it participates cleanly in the composite primary key).
    sector        TEXT NOT NULL DEFAULT '',

    min_val       NUMERIC,
    p25           NUMERIC,
    p50           NUMERIC,
    p75           NUMERIC,
    max_val       NUMERIC,
    sample_count  INTEGER NOT NULL DEFAULT 0,

    computed_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (metric, sector)
);

CREATE INDEX IF NOT EXISTS idx_metric_stats_metric ON metric_stats (metric);

CREATE TRIGGER metric_stats_updated_at
    BEFORE UPDATE ON metric_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- RLS — public read, service-role-only writes (matches migration 020).
-- ============================================================
ALTER TABLE metric_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read" ON metric_stats;
CREATE POLICY "public read" ON metric_stats
    FOR SELECT USING (true);
