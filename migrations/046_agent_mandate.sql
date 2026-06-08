-- Migration 046: per-agent individual mandates (team builder, brief v2).
--
-- In the old model every LLM-driven agent read one shared mandate
-- (portfolios.description). The team-builder world makes the team *be* the
-- strategy, so a single overall mandate no longer fits. Each thinking agent now
-- carries its OWN brief, pre-filled with a sensible default, so a team works out
-- of the box but each agent can be tuned individually.
--
-- Mirrors how params already work (migration 045): the DEFAULT lives on the
-- agent definition, the saved INSTANCE can override. Resolution at heartbeat
-- time is `instance override ?? agent default ?? (legacy) portfolio.description`.
--
-- Only "thinking" agents (those whose engine consumes a brief — the LLM buyer
-- and the LLM reviewer) carry a default_mandate. Mechanical/manage agents leave
-- it NULL and the UI shows no brief field for them.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. Columns
-- ============================================================
-- agents.default_mandate: the baked-in brief. Presence (NOT NULL) is what marks
--   an agent as a thinking agent that shows a brief field.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_mandate TEXT;

-- portfolio_agents.mandate: the per-instance override. NULL = use the agent's
--   default (and keep tracking it as the default evolves).
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS mandate TEXT;

-- ============================================================
-- 2. Re-seed the example library with default mandates
-- ============================================================
-- Buy agents move onto the thinking buyer (llm_watchlist_buyer) so the brief
-- actually drives BUY/PASS; sell agents stay on the LLM reviewer; manage agents
-- keep NULL default_mandate (no engine, no brief). Idempotent: extends the
-- migration-045 seed in place.

UPDATE agents SET strategy = 'llm_watchlist_buyer', default_mandate =
    'Own elite Rule-of-40 compounders — durable revenue growth paired with strong free cash flow. Favour proven models over hype, and skip names already priced for perfection.'
    WHERE handle = 'agent-quality-compounder';

UPDATE agents SET strategy = 'llm_watchlist_buyer', default_mandate =
    'Buy strength — names breaking out to new highs on improving fundamentals. Avoid breakouts riding deteriorating margins or fading growth.'
    WHERE handle = 'agent-momentum-breakout';

UPDATE agents SET strategy = 'llm_watchlist_buyer', default_mandate =
    'Buy quality at a discount — sound businesses trading cheaply on sales. Demand a real margin of safety, not just a low multiple on a broken story.'
    WHERE handle = 'agent-deep-value-sniper';

UPDATE agents SET strategy = 'llm_watchlist_buyer', default_mandate =
    'Buy quality on weakness — durable names that have pulled back, not falling knives. Confirm the thesis still holds before adding.'
    WHERE handle = 'agent-dip-buyer';

UPDATE agents SET strategy = 'llm_watchlist_buyer', default_mandate =
    'Buy durable franchises trading well below their long-run trend, where the business is intact and the discount is sentiment rather than deterioration.'
    WHERE handle = 'agent-200w-reversion';

UPDATE agents SET default_mandate =
    'Cut losers fast — exit any position that falls meaningfully below its entry price. Never average down a broken position.'
    WHERE handle = 'agent-hard-stop-loss';

UPDATE agents SET default_mandate =
    'Let winners run but protect gains — exit when a position gives back a meaningful chunk from its peak since purchase.'
    WHERE handle = 'agent-trailing-stop';

UPDATE agents SET default_mandate =
    'Bank gains into strength — take profits once a position has run, trimming back toward a core holding rather than exiting wholesale.'
    WHERE handle = 'agent-target-trimmer';

UPDATE agents SET default_mandate =
    'Keep capital working — close positions that have been held past their intended horizon without delivering, freeing cash for fresher ideas.'
    WHERE handle = 'agent-time-based-exit';

UPDATE agents SET default_mandate =
    'Exit on outsized adverse moves relative to a name''s normal volatility — a break well beyond its typical range signals a changed regime, not noise.'
    WHERE handle = 'agent-volatility-stop';

-- Manage agents (equal-weight balancer, risk-parity sizer) intentionally keep
-- default_mandate NULL — mechanical, no brief.
