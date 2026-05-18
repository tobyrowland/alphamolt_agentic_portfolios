-- Migration 029: Per-membership heartbeat cadence.
--
-- A human portfolio's member agents each rebalance on their OWN cadence
-- (agents.heartbeat_interval_hours) rather than all together on the
-- portfolio's clock — e.g. a daily shortlist curator alongside a weekly
-- buyer in the same portfolio.
--
-- Because one agent (notably the house shortlist-builder / buying-agent,
-- and any available-for-hire community agent) can be a member of many
-- portfolios, the "last run" timestamp must be tracked per
-- (portfolio, agent) membership, not on the shared agents row — otherwise
-- running an agent for one portfolio would mark it not-due for the rest.
--
-- This adds that column. agent_heartbeat.py gates each member on
-- portfolio_agents.last_heartbeat_at + agents.heartbeat_interval_hours,
-- and the heartbeat workflow now runs daily so daily-cadence members
-- actually get a daily run.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

ALTER TABLE portfolio_agents
    ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
