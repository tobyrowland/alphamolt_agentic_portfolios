-- Migration 047: adapt the real house agents to the team-builder library.
--
-- The team builder's library is "hireable agents with an action set" (migration
-- 045). The illustrative seed agents from 045 are placeholders; the *real*
-- roster is the house agents that already run live strategies. This migration
-- promotes them into the library so the team builder isn't empty:
--
--   * the four LLM buyers (buyer-gemini / -claude / -chatgpt / -grok, all
--     `llm_watchlist_buyer`) → action 'buy', one brain each;
--   * the LLM reviewer (portfolio-reviewer, `portfolio_reviewer`) → action 'sell'.
--
-- Each gets the param + sentence + default-mandate fields the builder reads, so
-- they're function-first, self-briefing, and tunable per instance. Their
-- existing UUIDs / portfolios / track records are untouched — only the library
-- presentation columns change.
--
-- Self-contained & idempotent: re-declares the 045/046 columns IF NOT EXISTS so
-- it can be applied on its own (e.g. if only the real roster is wanted, without
-- the 045 example seeds). Paste-and-run in the Supabase SQL editor.

-- ---- Columns (mirror of 045 + 046, for standalone safety) -----------------
ALTER TABLE agents ADD COLUMN IF NOT EXISTS action            TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS triggers          TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS param_schema      JSONB  NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sentence_template TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS default_mandate   TEXT;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_action_check;
ALTER TABLE agents ADD  CONSTRAINT agents_action_check
    CHECK (action IS NULL OR action IN ('buy', 'sell', 'manage'));
CREATE INDEX IF NOT EXISTS idx_agents_library ON agents (action) WHERE action IS NOT NULL;
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS mandate TEXT;

-- ---- The four LLM buyers → action 'buy' -----------------------------------
-- Same strategy (llm_watchlist_buyer) offered on four brains: weighs every
-- candidate against its brief and buys only its highest-conviction names.
-- `target_position_pct` is the tunable size (maps straight onto the strategy's
-- config key, so the slider actually changes sizing on the non-swarm path).
UPDATE agents SET
    action            = 'buy',
    display_name      = 'Conviction Buyer · Gemini',
    powered_by        = 'Gemini 2.5 Pro',
    available_for_hire = TRUE,
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only its highest-conviction names, up to {target_position_pct}% per position.',
    default_mandate   = 'Build a focused book of your best ideas — own high-quality businesses with durable growth at a sensible entry price, and pass on anything you do not have strong conviction in.'
    WHERE handle = 'buyer-gemini';

UPDATE agents SET
    action            = 'buy',
    display_name      = 'Conviction Buyer · Claude',
    powered_by        = 'Claude Opus 4.8',
    available_for_hire = TRUE,
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only its highest-conviction names, up to {target_position_pct}% per position.',
    default_mandate   = 'Build a focused book of your best ideas — own high-quality businesses with durable growth at a sensible entry price, and pass on anything you do not have strong conviction in.'
    WHERE handle = 'buyer-claude';

UPDATE agents SET
    action            = 'buy',
    display_name      = 'Conviction Buyer · GPT-5',
    powered_by        = 'GPT-5',
    available_for_hire = TRUE,
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only its highest-conviction names, up to {target_position_pct}% per position.',
    default_mandate   = 'Build a focused book of your best ideas — own high-quality businesses with durable growth at a sensible entry price, and pass on anything you do not have strong conviction in.'
    WHERE handle = 'buyer-chatgpt';

UPDATE agents SET
    action            = 'buy',
    display_name      = 'Conviction Buyer · Grok',
    powered_by        = 'Grok 4',
    available_for_hire = TRUE,
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only its highest-conviction names, up to {target_position_pct}% per position.',
    default_mandate   = 'Build a focused book of your best ideas — own high-quality businesses with durable growth at a sensible entry price, and pass on anything you do not have strong conviction in.'
    WHERE handle = 'buyer-grok';

-- ---- The LLM reviewer → action 'sell' -------------------------------------
-- `sell_conviction_threshold` maps onto the reviewer's config key: it sells a
-- holding when its conviction to exit reaches the bar (out of 5).
UPDATE agents SET
    action            = 'sell',
    powered_by        = 'Gemini 2.5 Pro',
    available_for_hire = TRUE,
    param_schema      = '[{"key":"sell_conviction_threshold","label":"Sell conviction","type":"number","min":1,"max":5,"step":1,"default":4}]'::jsonb,
    sentence_template = 'Reviews each holding against your brief and sells when its conviction to exit reaches {sell_conviction_threshold} of 5.',
    default_mandate   = 'Sell a holding when the reason you bought it no longer holds — broken fundamentals, a failed thesis, or a clearly better use of the capital. Otherwise, let winners run.'
    WHERE handle = 'portfolio-reviewer';
