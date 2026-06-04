-- Migration 041: portfolio swarm (portfolio page brief §3/§4).
--
-- A portfolio runs a SWARM: multiple specialist buyers + multiple reviewers,
-- coordinated per cycle (snake-draft buying, first-valid-sell). This adds the
-- per-membership config the coordination engine (swarm.py + agent_heartbeat.
-- _run_portfolio_swarm) needs, plus per-position attribution.
--
-- Buying — snake draft: each cycle the buyers draft from the shared top-N
-- screen candidates one name at a time (rotating/reversing order); a buyer only
-- drafts a name that clears ITS conviction bar; shared cash; a drafted name is
-- taken (resolves duplicate picks). Each position is attributed to its buyer.
-- Selling — first valid sell: reviewers run in order on the shared book; the
-- first to close a name wins.
--
-- Backward compatible: the swarm path is opt-in (runs only when
-- portfolios.draft_config is set AND the portfolio has role='buyer' members).
-- NULL role = legacy member, runs its agents.strategy as before. Depends on
-- migration 040 (screen_config / screen_facts). Idempotent.

-- Per-membership role + remit + knobs (conviction gate, max % per name,
-- cadence, focus, sell rules, brain).
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS role  TEXT;   -- 'buyer' | 'reviewer'
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS remit TEXT;   -- free-text specialty/focus
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS config JSONB; -- {convictionGate,maxPerName,cadence,sellRules,brain}

-- Per-portfolio draft settings, e.g. {"order":"snake","cycle":"daily"}.
-- Presence of this column value is the opt-in switch for the swarm path.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS draft_config JSONB;

-- Attribution: which buyer drafted (opened) the position. Track records stay
-- per-buyer even though cash is a shared pool.
ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS opened_by_agent_id UUID REFERENCES agents(id);

-- Backfill role from each member's current strategy so existing swarms keep
-- working once their owner opts into a draft_config.
UPDATE portfolio_agents pa SET role = 'buyer'
FROM agents a
WHERE a.id = pa.agent_id
  AND a.strategy IN ('llm_watchlist_buyer', 'watchlist_buyer')
  AND pa.role IS NULL;

UPDATE portfolio_agents pa SET role = 'reviewer'
FROM agents a
WHERE a.id = pa.agent_id
  AND a.strategy = 'portfolio_reviewer'
  AND pa.role IS NULL;
