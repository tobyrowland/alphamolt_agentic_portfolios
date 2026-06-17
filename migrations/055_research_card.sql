-- Migration 055: shared per-equity research card on ai_analysis.
--
-- bull/bear are coarse (binary ✅/❌). The research card broadens the shared,
-- compute-once-per-equity layer with structured, scored business analysis that
-- every portfolio's buyer reads instead of re-deriving from raw numbers each
-- run. One JSONB column keeps it extensible (new dimensions need no migration):
--
--   research_card = {
--     "quality_score": 1-5,                          -- rolled-up
--     "moat":               {"score":1-5,"rationale":"…","evidence":"…"},
--     "growth_durability":  {"score":1-5,…},
--     "earnings_quality":   {"score":1-5,…},
--     "balance_sheet_risk": {"score":1-5,…},         -- 5 = safest
--     "break_signals": [{"field":"gross_margin_pct","op":"<","value":55,…}, …],
--     "model": "…", "version": 1
--   }
--
-- `researched_at` is the per-kind rotation clock (mirrors bull_at/bear_at/
-- narrated_at, migration 054) — research_evaluation.py refreshes the stalest
-- first. Public-read / service-role-write inherited from migration 053.
-- Additive & idempotent.
--
-- PREREQUISITE: this ALTERs `ai_analysis`, which is created by migration 053 and
-- extended by 054. Apply 053 → 054 → 055 in order. (As of writing, 053/054 were
-- NOT yet applied to the live project — verify `ai_analysis` exists first.)

ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS research_card JSONB;
ALTER TABLE ai_analysis ADD COLUMN IF NOT EXISTS researched_at TIMESTAMPTZ;

-- Staleness scan ("oldest N to research") orders by the clock NULLS FIRST.
CREATE INDEX IF NOT EXISTS idx_ai_analysis_researched_at
    ON ai_analysis (researched_at NULLS FIRST);

COMMENT ON COLUMN ai_analysis.research_card IS
    'Shared per-equity scored business analysis (moat/growth durability/earnings quality/balance-sheet risk, 1-5 + rationale) + a base set of break signals. Read by the buyer; written by research_evaluation.py. See migration 055.';
