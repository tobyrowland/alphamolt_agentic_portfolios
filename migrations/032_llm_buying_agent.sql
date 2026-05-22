-- Migration 032: Rebrand `buying-agent` as the LLM-driven Alphamolt Buyer.
--
-- Background. The house buyer has been running `watchlist_buyer` (mechanical
-- equal-weighting of every watchlist row, less a 2% cash reserve). It can't
-- discriminate between names, can't weigh the curator's reasoning, and
-- floods the book with diluted positions. This migration switches the
-- house buyer to a new strategy `llm_watchlist_buyer` that:
--
--   * Evaluates each watchlist equity with a frontier model (Gemini 2.5 Pro)
--     against the portfolio mandate + a new per-portfolio buy-decisions
--     mandate + the curator's rationale + extended-tier financial data.
--   * Returns BUY|PASS verdicts with conviction 1-5 per equity.
--   * Only trades names that come out at the hard 5/5 threshold; a final
--     LLM call orders the 5/5s by portfolio fit.
--   * Buys each name at a 4% target weight; the last position may drop
--     to a 2% floor when cash runs out. Stops when cash < 2% of portfolio.
--   * Records a forward-looking thesis per buy (text + extend/break
--     signals) via the existing `theses.record_thesis` pipeline.
--
-- The mechanical `watchlist_buyer` strategy code stays in place for any
-- community agent that wants it; this migration only re-strats the house
-- `buying-agent` row.
--
-- A new portfolios.buy_mandate column is added so portfolio owners can
-- write a separate brief describing HOW to evaluate buys (distinct from
-- the existing description = WHAT the portfolio is meant to be).
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. portfolios.buy_mandate — owner-set per-portfolio buy brief
-- ============================================================
-- The LLM buyer reads this alongside `portfolios.description`. NULL =
-- no per-buy rules; the buyer works to the main mandate alone.

ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS buy_mandate TEXT;


-- ============================================================
-- 2. agents — re-strat the house buying agent + seed its config
-- ============================================================
-- Strategy dispatcher keys on `agents.strategy`, not handle. All existing
-- portfolio memberships, cash accounts, and any prior theses authored by
-- this agent stay attached to the agent's UUID and continue to work.

UPDATE agents
   SET strategy        = 'llm_watchlist_buyer',
       display_name    = 'Alphamolt Buyer',
       description     = 'House buyer for alphamolt.ai. Each night, evaluates every watchlist equity against the portfolio''s mandate (and optional buy-decisions mandate), ranks the highest-conviction picks, and buys only 5/5 conviction names at a 4% target weight. Records a forward-looking investment thesis per buy. Brain: gemini-2.5-pro (google).',
       long_description = $md$# Strategy: llm_watchlist_buyer

The thinking buyer half of the alphamolt.ai pipeline for human-owned
portfolios. Pairs with `alphamolt-shortlist` (the curator) on a daily
heartbeat: the curator builds the watchlist, the buyer evaluates each
name and buys the highest-conviction picks.

## Decision flow per heartbeat

1. **Cash gate.** Skip if cash is less than 2% of portfolio value.
2. **Per-equity LLM call.** For each watchlist ticker not already held
   at ≥ 4%, an LLM call evaluates it against the portfolio's mandate,
   the per-portfolio buy-decisions mandate, the curator's rationale,
   and the extended-tier financial data (fundamentals + valuation +
   narrative + prior in-house verdicts). Returns
   `{verdict: BUY|PASS, conviction: 1-5, thesis_text, extend_signals,
   break_signals}`.
3. **Conviction filter.** Only `verdict=BUY` AND `conviction=5` survives.
4. **Prioritisation.** If two or more candidates qualify, a final LLM
   call orders them by portfolio fit. The 5/5 threshold is a hard
   gate — Phase 2 only orders, it cannot promote a 4/5.
5. **Trade execution.** Buys in ranked order at 4% of portfolio per
   position. When cash drops below 4% but ≥ 2%, the next position is
   sized at the remaining cash. When cash drops below 2%, stops.
6. **Thesis per buy.** Every executed buy records an `investment_theses`
   row with the LLM's `thesis_text` plus machine-checkable
   `extend_signals` / `break_signals`, so the existing
   `theses.check_thesis` machinery can later verdict the position as
   active / broken / improved.

## Discipline

- **No selling.** This agent only buys. Existing positions are not
  reviewed for prune. A future agent can take that role.
- **No piling in.** A watchlist name already held at ≥ 4% weight is
  skipped before the LLM call (saves cost; enforces concentration cap).
- **One thesis per ticker.** A watchlist name with an existing
  `status='active'` investment_theses row is skipped — the buyer won't
  re-buy a name we already have a thesis on, so the original
  extend/break signals are preserved.
- **Idempotent.** Re-running the heartbeat on an unchanged book + watchlist
  is a no-op modulo cash drift.

Only meaningful for shared human portfolios; on a legacy 1:1 agent
portfolio it is a no-op.

**Source code:** `llm_watchlist_buyer.rebalance_llm_watchlist_buyer`.$md$,
       config          = jsonb_build_object(
           'provider',             'google',
           'model',                'gemini-2.5-pro',
           'min_cash_pct',         2.0,
           'target_position_pct',  4.0,
           'min_position_pct',     2.0,
           'min_conviction',       5,
           'concurrency',          5,
           'per_call_timeout_sec', 90,
           'max_tokens',           65536,
           'max_tokens_phase2',    16384,
           'temperature',          0.2,
           'max_signals_per_kind', 5
       ),
       updated_at      = NOW()
 WHERE handle = 'buying-agent';


-- ============================================================
-- 3. portfolios — refresh the 1:1 portfolio row to mirror the agent
-- ============================================================
-- portfolios.id == agent.id (migration 021 / 028's 1:1 shim), so the
-- portfolio's display strings can be re-keyed straight off the agent row.

UPDATE portfolios p
   SET slug = a.handle,
       display_name = a.display_name,
       description  = a.description,
       updated_at   = NOW()
  FROM agents a
 WHERE a.handle = 'buying-agent'
   AND p.id     = a.id;
