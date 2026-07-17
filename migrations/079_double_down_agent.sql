-- Migration 079: the Double-Down conviction-add buyer (library agent).
--
-- Adds one hireable, public house agent that presses a portfolio's existing
-- bets: each heartbeat it re-evaluates the names the portfolio ALREADY HOLDS
-- and adds to the ones that still look really good, sizing each winner up
-- toward a concentration ceiling. It never opens a new position and never
-- sells (agent_strategies.py + double_down.py).
--
-- It is a *self-sourced* buyer (action='buy' → heartbeat role 'buyer'): its
-- candidate feed is the current book, not the screen, so the swarm runs its
-- full strategy standalone against the shared book BEFORE the snake draft (see
-- agent_strategies.SELF_SOURCED_BUYER_STRATEGIES) — its adds settle and the
-- draft sees the resulting cash.
--
-- LLM-powered: the "does this still look really good?" judgement reuses the
-- shared buyer thinking core (llm_watchlist_buyer.evaluate_candidates) on the
-- Claude brain, so it carries a default_mandate (an editable brief) and a
-- config with provider/model, like the Conviction Buyers (migrations 036/047).
-- The brain also lives in the strategy DEFAULTS so the self-sourced swarm path
-- (which passes only the membership param knobs) resolves it regardless.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

INSERT INTO agents (
    handle, display_name, description, is_house_agent, available_for_hire,
    api_key_hash, api_key_prefix, powered_by, strategy, config,
    heartbeat_interval_hours, action, triggers, param_schema, sentence_template
)
SELECT
    'double-down', 'Double-Down Buyer',
    'Adds to the winners you already hold — when a holding still looks really good it buys more of it, in steps, up to a per-position ceiling. Never opens new names and never sells.',
    TRUE, TRUE, 'house-agent', 'ak_house_dd', 'Claude Opus 4.8', 'double_down',
    jsonb_build_object('provider', 'anthropic', 'model', 'claude-opus-4-8'),
    24, 'buy', '{}',
    '[]'::jsonb, ''
WHERE NOT EXISTS (
    SELECT 1 FROM agents WHERE handle = 'double-down'
);

UPDATE agents SET
    strategy           = 'double_down',
    display_name       = 'Double-Down Buyer',
    description        = 'Adds to the winners you already hold — when a holding still looks '
                         'really good it buys more of it, in steps, up to a per-position '
                         'ceiling. Never opens new names and never sells.',
    action             = 'buy',
    triggers           = '{}',
    available_for_hire = TRUE,
    is_house_agent     = TRUE,
    powered_by         = 'Claude Opus 4.8',
    -- Keep provider/model on the agent for the non-swarm path + documentation;
    -- the strategy DEFAULTS guarantee the brain on the self-sourced swarm path.
    config             = COALESCE(config, '{}'::jsonb)
                         || jsonb_build_object('provider', 'anthropic', 'model', 'claude-opus-4-8'),
    default_mandate    = 'Press your winners. Add to holdings whose thesis is still intact and '
                         'improving — durable growth, strengthening fundamentals, a reasonable '
                         'price for what you are getting — and only when your conviction to size '
                         'up TODAY is genuinely high. If a name has merely drifted up on noise, '
                         'or the story has weakened, leave the position where it is.',
    param_schema       = '[
        {"key":"max_position_pct","label":"Max per position","type":"number","min":4,"max":15,"step":0.5,"unit":"%","default":8},
        {"key":"add_position_pct","label":"Add step size","type":"number","min":1,"max":8,"step":0.5,"unit":"%","default":4},
        {"key":"min_conviction","label":"Only add at conviction","type":"number","min":3,"max":5,"step":1,"unit":"/5","default":5}
    ]'::jsonb,
    sentence_template  =
        'Adds to the winners you already hold — when a holding still looks really '
        'good, buys more of it in {add_position_pct}% steps up to {max_position_pct}% '
        'of the portfolio, only at conviction {min_conviction}/5 or higher.'
    WHERE handle = 'double-down';
