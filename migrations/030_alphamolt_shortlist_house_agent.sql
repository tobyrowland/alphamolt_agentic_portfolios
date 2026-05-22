-- Migration 030: Rebrand `shortlist-builder` → `alphamolt-shortlist`, target 40 names.
--
-- Background: migration 028 launched the curator half of the two-agent
-- pipeline under the generic handle `shortlist-builder` with a 20-name target.
-- We're rebranding it as the alphamolt.ai house curator and bumping the
-- target shortlist to 40 — a wider list still flows through the existing
-- `watchlist_buyer` (which equal-weights whatever it finds), so the only
-- visible change for owners is more names + alphamolt branding.
--
-- The strategy dispatcher keys on `agents.strategy` (= 'watchlist_curator'),
-- not handle, and every relation (portfolios.id, portfolio_agents.agent_id,
-- agent_accounts.agent_id, portfolio_watchlist.added_by_agent_id) references
-- the agent's UUID. Renaming the handle is therefore safe: existing
-- portfolio memberships, the 1:1 portfolio row, the cash account, and any
-- watchlist rows it has already authored all stay attached.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. agents — rebrand the curator + widen the shortlist target
-- ============================================================

UPDATE agents
   SET handle = 'alphamolt-shortlist',
       display_name = 'Alphamolt Shortlist',
       description = 'House curator for alphamolt.ai. For every portfolio it joins, reads the owner''s mandate and picks a ~40-name shortlist from the daily equity universe. Runs daily. Brain: gemini-2.5-flash (google).',
       long_description = $md$# Strategy: watchlist_curator

The mandate-aware house curator for alphamolt.ai — the curator half of the
two-agent pipeline for human-owned portfolios.

Each heartbeat it loads the daily compact universe snapshot, builds an LLM
prompt from that snapshot plus the portfolio's free-text **mandate**, and
asks the model for ~40 tickers with a one-line rationale each. Every
ticker is validated against the `companies` universe.

It refreshes only its own `source='agent'` watchlist rows — other curators'
picks and the owner's manual `source='user'` picks are never touched. A
buyer agent (`watchlist_buyer`) trades from the shortlist on its own
(weekly) cadence; the heartbeat orders curate-phase members before
trade-phase ones so the buyer always sees the freshest list.

Only meaningful for shared human portfolios; on a legacy 1:1 agent
portfolio it is a no-op.

**Source code:** `agent_strategies.rebalance_watchlist_curator`.$md$,
       config = jsonb_set(COALESCE(config, '{}'::jsonb), '{watchlist_size}', '40'::jsonb, true),
       updated_at = NOW()
 WHERE handle = 'shortlist-builder';


-- ============================================================
-- 2. portfolios — re-slug the 1:1 portfolio row to match the new handle
-- ============================================================
-- portfolios.id == agent.id (migrations 021 + 028 1:1 shim), so we re-key
-- by UUID and refresh the display strings from the renamed agent row.

UPDATE portfolios p
   SET slug = a.handle,
       display_name = a.display_name,
       description = a.description,
       updated_at = NOW()
  FROM agents a
 WHERE a.handle = 'alphamolt-shortlist'
   AND p.id = a.id;
