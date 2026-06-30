-- Migration 069: the Sector Rebalancer (concentration cap) library agent.
--
-- Adds one hireable, mechanical sell-side agent that caps any single GICS
-- sector's weight in a human portfolio. Hiring it has TWO effects, both keyed
-- off the same `max_sector_pct` slider (agent_strategies.py + sector_rebalancer.py):
--
--   * BUY side  — the swarm reads the cap and the snake draft refuses any pick
--     that would push its sector over the cap, so cash freed elsewhere can't
--     re-concentrate the same sector (agent_heartbeat._run_portfolio_swarm →
--     swarm.snake_draft_plan).
--   * SELL side — it runs in the reviewer loop and PARTIAL-trims a sector that
--     is already over cap (price drift / manual buys), weakest screen-rank
--     names first, down to the cap.
--
-- Mechanical (no LLM), so default_mandate stays NULL (migration 046 convention:
-- no editable brief field for an engine that reads none). action='sell' maps to
-- the heartbeat 'reviewer' role.
--
-- Idempotent / paste-and-run in the Supabase SQL editor.

INSERT INTO agents (
    handle, display_name, description, is_house_agent, available_for_hire,
    api_key_hash, api_key_prefix, powered_by, strategy,
    action, triggers, param_schema, sentence_template
)
SELECT
    'sector-rebalancer', 'Sector Rebalancer',
    'Keeps any one GICS sector under a chosen share of the portfolio — blocks buys that would breach the cap and trims the weakest names when a sector runs over.',
    TRUE, TRUE, 'house-agent', 'ak_house_sr', 'Rules-based', 'sector_rebalancer',
    'sell', '{}',
    '[]'::jsonb, ''
WHERE NOT EXISTS (
    SELECT 1 FROM agents WHERE handle = 'sector-rebalancer'
);

UPDATE agents SET
    strategy           = 'sector_rebalancer',
    display_name       = 'Sector Rebalancer',
    description        = 'Keeps any one GICS sector under a chosen share of the portfolio — '
                         'blocks buys that would breach the cap and trims the weakest names '
                         'when a sector runs over.',
    action             = 'sell',
    triggers           = '{}',
    available_for_hire = TRUE,
    is_house_agent     = TRUE,
    powered_by         = 'Rules-based',
    default_mandate    = NULL,
    -- Ceiling 100 so "no real cap" is expressible on the agent itself (a
    -- single-sector investor simply doesn't hire it; this is the graceful high
    -- end for anyone who wants a very loose cap).
    param_schema       = '[
        {"key":"max_sector_pct","label":"Max per sector","type":"number","min":10,"max":100,"step":5,"unit":"%","default":30}
    ]'::jsonb,
    sentence_template  =
        'Keeps any one sector under {max_sector_pct}% of the portfolio — blocks '
        'buys that would breach it and trims the weakest names when a sector runs over.'
    WHERE handle = 'sector-rebalancer';
