-- Migration 050: Profit Taker — a one-time gain-banking sell agent.
--
-- A mechanical sell-side trimmer for the team-builder library: when a holding
-- has grown by `gain_pct` versus its cost basis, it sells `sell_pct` of the
-- position to bank the gain, then never touches that equity again. Backed by
-- agent_strategies.rebalance_profit_taker (strategy = 'profit_taker'); the
-- "once per equity, ever" rule is enforced durably via the trade journal.
--
-- Two knobs (brief §2: 1-2 typed, bounded controls):
--   * gain_pct — the gain that triggers a trim (% above cost)
--   * sell_pct — how much of the position to sell when triggered (100 = exit)
--
-- Action 'sell' → heartbeat role 'reviewer'; trigger tag 'banks-gains' (it is
-- declared, not detected — the readiness strip reasons over it). Mechanical, so
-- no LLM brain (`powered_by` = 'Rules-based') and `default_mandate` stays NULL
-- (no brief field — nothing reads one).
--
-- Idempotent (INSERT ... WHERE NOT EXISTS, then UPDATE). Paste-and-run in the
-- Supabase SQL editor.

-- ---- Create the row if it doesn't exist yet -------------------------------
INSERT INTO agents (
    handle, display_name, description, is_house_agent, available_for_hire,
    api_key_hash, api_key_prefix, powered_by, strategy,
    action, triggers, param_schema, sentence_template
)
SELECT
    'agent-profit-taker', 'Profit Taker',
    'Banks a one-time profit: when a holding is up by your target, sells a set slice and never touches it again.',
    TRUE, TRUE, 'house-agent', 'ak_house_pt', 'Rules-based', 'profit_taker',
    'sell', '{banks-gains}',
    '[]'::jsonb, ''
WHERE NOT EXISTS (
    SELECT 1 FROM agents WHERE handle = 'agent-profit-taker'
);

-- ---- Set the authoritative library fields (covers new + pre-existing) -----
UPDATE agents SET
    strategy          = 'profit_taker',
    display_name      = 'Profit Taker',
    description       = 'Banks a one-time profit: when a holding is up by your target, '
                        'sells a set slice and never touches it again.',
    action            = 'sell',
    triggers          = '{banks-gains}',
    available_for_hire = TRUE,
    is_house_agent    = TRUE,
    powered_by        = 'Rules-based',
    default_mandate   = NULL,
    param_schema      = '[
        {"key":"gain_pct","label":"Gain trigger","type":"number","min":5,"max":200,"step":5,"unit":"%","default":25},
        {"key":"sell_pct","label":"Sell amount","type":"number","min":10,"max":100,"step":5,"unit":"%","default":50}
    ]'::jsonb,
    sentence_template =
        'When a holding is up {gain_pct}% from its cost, sells {sell_pct}% of it '
        'to bank the gain — once per equity, ever.'
    WHERE handle = 'agent-profit-taker';
