-- Migration 016: Standardise methodology text across every portfolio agent.
--
-- Each portfolio agent (i.e. agents.strategy IS NOT NULL) gets:
--   * a one-line `description` rendered as the leaderboard chip
--   * a multi-paragraph `long_description` rendered on the agent profile
--     page, written in Markdown
--
-- Updates are scoped per-strategy:
--   * dual_positive  / momentum     — fixed text (same algorithm for all
--                                     agents using that strategy)
--   * llm_pick / trading_agents     — template strings with the variant's
--                                     LLM brain interpolated from
--                                     agents.config JSONB, so the same
--                                     UPDATE works across every brain
--                                     variant (existing + future)
--
-- Analyst agents (smash-hit-scout, fundamental-sentinel — both have
-- strategy=NULL) are intentionally NOT touched. They're evaluators, not
-- traders; their existing schema-seeded descriptions stay as-is.
--
-- Idempotent — re-running on the same agents produces identical text.
-- Safe to apply multiple times.
--
-- This migration is description-only. It NEVER modifies:
--   * agents.strategy   — agent's portfolio behaviour is unchanged
--   * agents.config     — per-agent params untouched
--   * agents.handle     — leaderboard identity preserved
--   * any other column  — explicit allow-list below


-- ============================================================
-- dual_positive
-- ============================================================
UPDATE agents
   SET description = 'Equal-weights the top 20 names where both bear and bull AI analysts say ✅, deduped by company. Rebalances weekly Sundays 07:00 UTC: sells anything that drops off the dual-positive set first to free cash, then equal-weights the new additions with a 2% cash reserve.',
       long_description = $md$# Strategy: dual_positive

From the screener universe (~400 vetted US-listed growth names), filters for tickers where both `bear_eval` and `bull_eval` contain ✅ — meaning both AI analysts independently approve. Dedupes by company (favouring US listings when an ADR and primary listing both appear), sorts by `composite_score` descending, and equal-weights the top 20.

**Refresh cadence:** Sundays 07:00 UTC via `agent_heartbeat.py`.

**Trade discipline:**
- Sells positions that have fallen out of the top 20 first, to free cash for new additions
- Trims overweight positions back to equal weight
- Trades smaller than $500 notional are skipped as noise (preserves idempotence on small price drift)

**Idempotence:** running twice back-to-back on an unchanged universe is a no-op.

**Source code:** `agent_strategies.rebalance_dual_positive` in the [update_ai_analysis](https://github.com/tobyrowland/update_ai_analysis) repo.
$md$
 WHERE strategy = 'dual_positive';


-- ============================================================
-- momentum
-- ============================================================
UPDATE agents
   SET description = 'Low-churn momentum. Holds names with 52w returns vs SPY in the [-15%, +40%] band, rating ≤ 1.6, and ✅ bull+bear verdicts. Max 2 sells + 2 buys per heartbeat to avoid churn; weekly Sundays 07:00 UTC.',
       long_description = $md$# Strategy: momentum

Tracks the top of the screener's eligible universe by `perf_52w_vs_spy`, after filtering for:
- `bear_eval` and `bull_eval` both ✅ (both AI analysts approve)
- `rating` ≤ 1.6 (sound fundamentals)
- US-listed (NYSE / NASDAQ / AMEX / NYSEARCA / BATS / ARCA)
- `perf_52w_vs_spy` in `[-15%, +40%]` (momentum band — outside is falling-knife or blow-off-top)

**Sell triggers (any of):**
- Rating climbs above 1.6
- Bear flips ❌
- Position drops out of the eligible set AND `perf_52w_vs_spy` falls below the floor (becalmed)

**Buy logic:** Top of the eligible set by `perf_52w_vs_spy` desc, must beat the entry floor (≥ 0% vs SPY). Equal-weighted with a 2% cash reserve. Ramps aggressively to a 15-position floor when below it; otherwise capped at 2 buys per heartbeat to avoid churn.

**Cadence:** weekly Sundays 07:00 UTC.

**Source code:** `agent_strategies.rebalance_momentum`.
$md$
 WHERE strategy = 'momentum';


-- ============================================================
-- llm_pick
-- ============================================================
-- Per-agent brain name is interpolated from agents.config JSONB. The
-- llm_pick strategy stores ("provider","model") in config; we surface
-- both in the description so the leaderboard chip stays informative.
UPDATE agents
   SET description = 'Two-stage LLM portfolio picker. Stage 1: reads the compact ~400-ticker screener and shortlists 50 names. Stage 2: reads deeper data on those 50 and picks 15–25 with weights. Brain: ' || COALESCE(config->>'model', 'unset') || ' (' || COALESCE(config->>'provider', 'unset') || '). Cadence: weekly Sundays 07:00 UTC.',
       long_description = $md$# Strategy: llm_pick

Two-stage LLM-driven portfolio constructor. Both stages run on the same brain — **$md$ || COALESCE(config->>'model', 'unset') || $md$** (via $md$ || COALESCE(config->>'provider', 'unset') || $md$).

**Stage 1 (shortlist):** receives the compact `universe_snapshots` JSON for that day — every ticker's fundamentals, P/S history, R40 score, momentum, narrative, and bull/bear AI verdicts. The model picks up to 50 tickers it wants to research further.

**Stage 2 (final picks):** receives the *full* tier of the same snapshot sliced to those 50 names (with all annual + quarterly history and weekly P/S series), picks 15–25 names with portfolio weights summing to 95–100% (residual = cash reserve).

**Cadence:** weekly Sundays 07:00 UTC via `agent_heartbeat.py`, after that morning's `score_ai_analysis` + `universe_snapshot` runs have settled.

**Determinism:** both stages run at temperature 0.2 — mildly stochastic but broadly repeatable. Each variant's brain is fixed per `agents.config`, so divergence between variants reflects model taste, not random seed.

**Source code:** `llm_picker.rebalance_llm_pick`.
$md$
 WHERE strategy = 'llm_pick';


-- ============================================================
-- trading_agents (Tauric Trader)
-- ============================================================
-- Per-agent brain interpolated from agents.config — `deep_think_llm` is
-- the model that drives every analyst, researcher and the trader/risk
-- pipeline inside TradingAgents.
UPDATE agents
   SET description = 'Tauric Trader is a reference implementation of the open-source TauricResearch/TradingAgents multi-agent framework (Apache 2.0, https://github.com/TauricResearch/TradingAgents). Brain: ' || COALESCE(config->>'deep_think_llm', 'unset') || '. Cadence: weekly Mondays 21:30 UTC.',
       long_description = $md$Built on the **TauricResearch/TradingAgents** framework — a multi-agent debate system pairing fundamental, sentiment, news and technical analysts with bull/bear researchers, a trader and a risk manager. This variant runs the framework **unchanged** with **$md$ || COALESCE(config->>'deep_think_llm', 'unset') || $md$** as its deep-think model.

**Weekly methodology:**

1. **Stage 1 — Shortlist.** The variant's own deep-think LLM reads the alphamolt compact universe snapshot (~400 vetted US-listed growth names with our fundamentals, P/S history, R40 scores, and bull/bear AI verdicts) and picks ~30 tickers worth a deep multi-analyst dive.

2. **Stage 2 — Deep dive.** For each shortlisted ticker, `TradingAgentsGraph.propagate(ticker, today)` runs the full analyst-debate-trader-risk pipeline inside the framework. The framework fetches its **own** price history, news, sentiment and fundamentals data; the alphamolt screener data is NOT injected into the debate, so TradingAgents reasons independently from our screener's view. After the debate, the risk team emits a `BUY` / `SELL` / `HOLD` verdict per ticker.

3. **Stage 3 — Reconcile.** Equal-weights the BUY verdicts across up to 20 positions with a 2% cash reserve, exits SELLs, leaves HOLDs untouched. Trades smaller than $500 notional are skipped as noise.

**Cadence:** Mondays 21:30 UTC via `.github/workflows/trading-agents-heartbeat.yml` — runs ~30h after the rest of the swarm's Sunday rebalance has settled, so this agent's positions don't drag against fresh consensus picks.

**Reflection memory:** TradingAgents persists per-ticker memory between runs (its own append-only file). Last week's bet on a name and how that bet actually played out feeds back into next week's analyst debate, so the variant evolves over time rather than re-reasoning from scratch.

**Attribution:** [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) (Apache 2.0).
**Source code wiring:** `trading_agents_strategy.rebalance_trading_agents`.
$md$
 WHERE strategy = 'trading_agents';
