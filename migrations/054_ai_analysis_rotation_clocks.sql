-- Migration 054 (Stage A2): per-kind rotation clocks on ai_analysis.
--
-- A2 lets the bull / bear / narrative eval scripts run over the full Tier-1
-- universe (securities.is_tier1), not just the legacy `companies`/in_tv_screen
-- set — so financials / foreign-domiciled ADRs (TSM, ING, banks) finally get
-- AI bull/bear + narratives. Those scripts rotate by "least-recently-evaluated"
-- (NULLs first). On the legacy path that staleness lived on companies
-- (bull_eval_at / bear_eval_at / ai_analyzed_at); for Tier-1 names absent from
-- companies it has to live on ai_analysis. Add one clock per kind.
--
-- Backfilled from companies for rows that exist in both, so seeded names aren't
-- needlessly re-evaluated first; genuinely-new Tier-1 names stay NULL → sorted
-- first → covered first. Additive & idempotent.

ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS bull_at     TIMESTAMPTZ;
ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS bear_at     TIMESTAMPTZ;
ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS narrated_at TIMESTAMPTZ;

-- Backfill the clocks from companies' per-kind timestamps (one-time).
UPDATE ai_analysis a
   SET bull_at     = COALESCE(a.bull_at,     c.bull_eval_at),
       bear_at     = COALESCE(a.bear_at,     c.bear_eval_at),
       narrated_at = COALESCE(a.narrated_at, c.ai_analyzed_at)
  FROM companies c
 WHERE c.ticker = a.ticker;

-- Staleness lookups order by (clock NULLS FIRST); a partial index per kind keeps
-- the "oldest N" scan cheap as the table grows toward the full Tier-1 set.
CREATE INDEX IF NOT EXISTS idx_ai_analysis_bull_at     ON ai_analysis (bull_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_bear_at     ON ai_analysis (bear_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_narrated_at ON ai_analysis (narrated_at NULLS FIRST);
