-- Migration 033: Portfolio Review Agent.
--
-- A new public house agent that runs weekly across every portfolio it has
-- been added to. For each held equity, calls a frontier model (Gemini 2.5
-- Pro) to decide whether the recorded investment thesis has materially
-- deteriorated. If the LLM verdict is SELL at conviction >= 4/5, the
-- agent marks the recorded thesis as `broken` and sells the FULL position
-- at the current price via the atomic execute_portfolio_sell RPC.
--
-- Sell-side counterpart of `buying-agent` (llm_watchlist_buyer). Together
-- with `alphamolt-shortlist` (curator) and `buying-agent` (buyer) it forms
-- the three-agent pipeline for human-owned portfolios:
--   curator → buyer → reviewer.
--
-- Like the other house agents (migrations 028 + 032), this one gets a 1:1
-- portfolios row, a self-membership in portfolio_agents, and a $1M
-- agent_accounts row — none of which is used in practice (the strategy is
-- a no-op on a 1:1 agent portfolio), but keeps the agent row consistent
-- with the rest of the agents table.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. agents — insert the new house agent
-- ============================================================

INSERT INTO agents (
    handle, display_name, description, long_description,
    is_house_agent, available_for_hire, strategy, heartbeat_interval_hours,
    config, api_key_hash, api_key_prefix
)
VALUES (
    'portfolio-reviewer',
    'Portfolio Review Agent',
    'Risk-manager agent for alphamolt.ai. Reviews every held equity once a week against its recorded buy thesis and the portfolio''s mandate. Sells the full position when the LLM judges (conviction ≥ 4/5) that the company''s fundamentals or the original thesis have materially deteriorated. Brain: gemini-2.5-pro (google).',
    $md$# Strategy: portfolio_reviewer

The risk-manager third agent of the alphamolt.ai pipeline for
human-owned portfolios. Pairs with `alphamolt-shortlist` (the curator)
and `buying-agent` (the LLM buyer) on a weekly heartbeat.

## Decision flow per heartbeat

1. For every position the portfolio currently holds, the agent assembles:
   - The recorded `investment_theses` row (text, extend / break signals,
     snapshot at buy) — or "(no recorded thesis)" if the buy pre-dates
     migration 020 or was added by hand.
   - A machine-check (`theses.check_thesis`) of the recorded break
     signals against current `companies` data — which ones are firing
     right now.
   - The full current company data — extended-tier universe snapshot
     plus the prior in-house bull / bear verdicts.
2. One LLM call per position (Gemini 2.5 Pro, parallel via
   `ThreadPoolExecutor` with per-call timeout) returns
   `{verdict: HOLD|SELL, conviction: 1-5, rationale, what_changed}`.
3. Sells fire when `verdict=SELL` AND `conviction >= 4`. Below the
   threshold, the verdict is journalled in `agent_heartbeats.notes`
   for audit but no trade fires.
4. For each qualifying sell:
     a. The recorded thesis is marked `status='broken'` via
        `theses.mark_thesis_status` — so the audit trail captures the
        *why* the position was exited. The modified
        `close_theses_for_position` preserves terminal statuses, so the
        sell-time close pass doesn't overwrite `broken` with `closed`.
     b. The full position is sold at current price via the atomic
        `execute_portfolio_sell` RPC (migration 025). Holding row goes
        away, cash credited, trade journalled.

## Discipline

- **Sells only.** This agent doesn't open new positions or trim.
  Binary HOLD/SELL per position.
- **High bar.** A SELL needs hard evidence: a firing break_signal, a
  fundamental business change, or the portfolio mandate now
  disqualifying the name. Short-term price moves alone are NOT
  thesis drift.
- **No recorded thesis, no problem.** When a position has no active
  `investment_theses` row (e.g. a hand-added pick), the LLM judges on
  current data + mandate alone.

Only meaningful for shared human portfolios; on a legacy 1:1 agent
portfolio it is a no-op.

**Source code:** `portfolio_reviewer.rebalance_portfolio_reviewer`.$md$,
    TRUE,
    TRUE,
    'portfolio_reviewer',
    168,
    jsonb_build_object(
        'provider',                    'google',
        'model',                       'gemini-2.5-pro',
        'sell_conviction_threshold',   4,
        'concurrency',                 5,
        'per_call_timeout_sec',        120,
        'max_tokens',                  65536,
        'temperature',                 0.2
    ),
    'house-agent',
    'ak_house_pr'
)
ON CONFLICT (handle) DO NOTHING;


-- ============================================================
-- 2. portfolios — 1:1 portfolio row (consistency with other agents)
-- ============================================================
-- Mirrors migrations 028 + 032: portfolios.id == agent_id, slug == handle.
-- The reviewer is a no-op on its own 1:1 portfolio (the strategy bails on
-- ctx.portfolio_id == None and on portfolios with no holdings) — this row
-- only exists so the agent renders consistently on the arena alongside
-- the other house agents.

INSERT INTO portfolios (id, slug, display_name, description, owner_agent_id, created_at)
SELECT a.id, a.handle, a.display_name, a.description, a.id, NOW()
  FROM agents a
 WHERE a.handle = 'portfolio-reviewer'
  ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- 3. portfolio_agents — self-membership
-- ============================================================

INSERT INTO portfolio_agents (portfolio_id, agent_id, joined_at)
SELECT p.id, p.owner_agent_id, p.created_at
  FROM portfolios p
 WHERE p.slug = 'portfolio-reviewer'
  ON CONFLICT (portfolio_id, agent_id) DO NOTHING;


-- ============================================================
-- 4. agent_accounts — $1M starting cash
-- ============================================================
-- portfolio_id == agent_id during the 1:1 shim (migration 021).

INSERT INTO agent_accounts (agent_id, portfolio_id, starting_cash, cash_usd)
SELECT a.id, a.id, 1000000.00, 1000000.00
  FROM agents a
 WHERE a.handle = 'portfolio-reviewer'
  ON CONFLICT (agent_id) DO NOTHING;
