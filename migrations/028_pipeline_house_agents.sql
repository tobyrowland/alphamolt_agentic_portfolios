-- Migration 028: Two-agent pipeline house agents.
--
-- Adds the two house agents that drive the curator -> buyer pipeline for
-- human-owned portfolios:
--
--   * shortlist-builder (strategy 'watchlist_curator') — a mandate-aware
--     LLM curator. Screens the daily universe snapshot against the
--     portfolio's mandate and writes a ~20-name shortlist into
--     portfolio_watchlist (source='agent').
--   * buying-agent (strategy 'watchlist_buyer') — a mechanical buyer.
--     Reads the portfolio's watchlist, equal-weights it, and places paper
--     trades, recording an investment thesis on each buy.
--
-- Each member rebalances on its own cadence (agents.heartbeat_interval_hours
-- + migration 029's per-membership clock): the curator runs daily (24h),
-- the buyer weekly (168h). On a day both are due the heartbeat runs the
-- curate-phase member before the trade-phase one (see
-- agent_strategies.STRATEGY_PHASES) so the buyer sees the fresh shortlist.
--
-- Like every other agent, each gets a 1:1 portfolios row (id == agent id),
-- a portfolio_agents self-membership, and an agent_accounts row — exactly
-- the way migration 021 backfilled the existing agents. Those legacy 1:1
-- portfolios are never traded by these strategies (both are no-ops without
-- a shared human portfolio_id); they exist purely so the agents are fully
-- consistent with the rest of the agents table and render on the arena.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. agents — the two house agents
-- ============================================================
-- api_key_hash = 'house-agent' sentinel (house agents can't authenticate
-- writes), with a placeholder api_key_prefix for the profile page.
-- shortlist-builder carries an LLM config bag mirroring llm_pick's
-- provider/model handling — the curator reads agents.config for these.

INSERT INTO agents (
    handle, display_name, description, long_description,
    is_house_agent, available_for_hire, strategy, heartbeat_interval_hours,
    config, api_key_hash, api_key_prefix
)
VALUES
    (
        'shortlist-builder',
        'Shortlist Builder',
        'Curator agent. Screens the daily equity universe against a portfolio''s mandate and writes a ~20-name shortlist into the portfolio watchlist for a buyer agent to trade from. Runs daily. Brain: gemini-2.5-flash (google).',
        $md$# Strategy: watchlist_curator

The curator half of the two-agent pipeline for human-owned portfolios.

Each heartbeat it loads the daily compact universe snapshot, builds an LLM
prompt from that snapshot plus the portfolio's free-text **mandate**, and
asks the model for ~15-25 tickers with a one-line rationale each. Every
ticker is validated against the `companies` universe.

It refreshes only its own `source='agent'` watchlist rows — other curators'
picks and the owner's manual `source='user'` picks are never touched. A
buyer agent (`watchlist_buyer`) trades from the shortlist on its own
(weekly) cadence; the heartbeat orders curate-phase members before
trade-phase ones so the buyer always sees the freshest list.

Only meaningful for shared human portfolios; on a legacy 1:1 agent
portfolio it is a no-op.

**Source code:** `agent_strategies.rebalance_watchlist_curator`.$md$,
        TRUE,
        TRUE,
        'watchlist_curator',
        24,
        '{"provider": "google", "model": "gemini-2.5-flash", "watchlist_size": 20}'::jsonb,
        'house-agent',
        'ak_house_sb'
    ),
    (
        'buying-agent',
        'Buying Agent',
        'Buyer agent. Reads a portfolio''s watchlist, equal-weights the candidates with a small cash reserve, and places paper trades — recording an investment thesis on each buy.',
        $md$# Strategy: watchlist_buyer

The buyer half of the two-agent pipeline for human-owned portfolios.

Each heartbeat it reads the portfolio's watchlist (both the owner's manual
`source='user'` picks and the curator's `source='agent'` picks), prices the
candidates, equal-weights them with a small cash reserve, and diffs against
the shared portfolio book. Holdings no longer on the watchlist are sold
first to free cash, then watchlist tickers are bought to their target
weight. Trades smaller than a noise floor are skipped, so running it twice
back-to-back on an unchanged watchlist is a no-op modulo price drift.

On every buy it records an investment thesis, using the watchlist row's
rationale as the thesis text when present.

Only meaningful for shared human portfolios; on a legacy 1:1 agent
portfolio, or with an empty watchlist, it is a no-op.

**Source code:** `agent_strategies.rebalance_watchlist_buyer`.$md$,
        TRUE,
        TRUE,
        'watchlist_buyer',
        168,
        '{}'::jsonb,
        'house-agent',
        'ak_house_ba'
    )
ON CONFLICT (handle) DO NOTHING;


-- ============================================================
-- 2. portfolios — 1:1 portfolio row per new house agent
-- ============================================================
-- Mirrors migration 021's backfill: portfolios.id == agent_id, slug ==
-- handle. Idempotent on the id.

INSERT INTO portfolios (id, slug, display_name, description, owner_agent_id, created_at)
SELECT a.id, a.handle, a.display_name, a.description, a.id, NOW()
  FROM agents a
 WHERE a.handle IN ('shortlist-builder', 'buying-agent')
  ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- 3. portfolio_agents — self-membership
-- ============================================================

INSERT INTO portfolio_agents (portfolio_id, agent_id, joined_at)
SELECT p.id, p.owner_agent_id, p.created_at
  FROM portfolios p
 WHERE p.slug IN ('shortlist-builder', 'buying-agent')
  ON CONFLICT (portfolio_id, agent_id) DO NOTHING;


-- ============================================================
-- 4. agent_accounts — $1M starting cash
-- ============================================================
-- portfolio_id == agent_id during the 1:1 shim (migration 021).

INSERT INTO agent_accounts (agent_id, portfolio_id, starting_cash, cash_usd)
SELECT a.id, a.id, 1000000.00, 1000000.00
  FROM agents a
 WHERE a.handle IN ('shortlist-builder', 'buying-agent')
  ON CONFLICT (agent_id) DO NOTHING;
