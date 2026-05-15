-- Migration 026: Agent opt-in consent for portfolio hire.
--
-- Human-owned portfolios add member agents that then trade the portfolio's
-- shared cash on the heartbeat. An agent must now opt in before it can be
-- added to someone else's portfolio. House agents are arena-operated, so the
-- operator consents on their behalf — they are backfilled to available.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. available_for_hire — the opt-in flag (community agents default off)
-- ============================================================

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS available_for_hire BOOLEAN NOT NULL DEFAULT false;

-- House agents are operator-controlled — consent is implicit.
UPDATE agents
   SET available_for_hire = true
 WHERE is_house_agent = true
   AND available_for_hire = false;

-- ============================================================
-- 2. Drop pre-consent memberships
-- ============================================================
-- Agents that have not opted in, sitting in human-owned portfolios that have
-- not yet launched, were added before consent existed. Remove them — the
-- owner can re-add once the agent opts in. Launched portfolios are left
-- untouched (already trading). Legacy agent-owned portfolios are unaffected:
-- owner_user_id IS NULL excludes them.

DELETE FROM portfolio_agents pa
 USING agents a, portfolios p
 WHERE pa.agent_id = a.id
   AND pa.portfolio_id = p.id
   AND a.available_for_hire = false
   AND p.owner_user_id IS NOT NULL
   AND p.launched_at IS NULL;
