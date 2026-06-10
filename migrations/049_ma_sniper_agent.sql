-- Migration 049: the 200-week average sniper as a real, hireable library agent.
--
-- A version of Charlie Munger's "sit on your hands until the fat pitch" sniper:
-- wait for a QUALITY business to trade down to its long-run trend (the 200-week
-- moving average), then strike. The seeded `agent-200w-reversion` (migration
-- 045) only *described* this and is illustrative — it was never inserted into
-- production (the real roster is curated separately; see migration 047). So this
-- migration is **insert-or-update**: it creates the agent if absent and points
-- it at the real `ma_sniper` engine (ma_sniper.py + agent_strategies.
-- rebalance_ma_sniper), which sources per-name conviction from each candidate's
-- distance to its 200-week MA.
--
-- Quality is supplied upstream: the candidate set is the top N of the
-- portfolio's screen (quality-weighted), so the agent only has to answer "is it
-- on sale vs its own 200-week average?". The band/size params map onto the
-- strategy's config keys the heartbeat reads on the swarm path.
--
-- Mechanical (no LLM brain): `powered_by` = 'Rules-based' and, per the
-- migration-046 convention, `default_mandate` stays NULL so the team builder
-- shows no editable brief field (a brief no engine would read).
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
    'agent-200w-reversion', '200-Week Sniper',
    'Buys quality companies only when they trade down to their 200-week average — and sits in cash until they do.',
    TRUE, TRUE, 'house-agent', 'ak_house_2w', 'Rules-based', 'ma_sniper',
    'buy', '{}',
    '[]'::jsonb, ''
WHERE NOT EXISTS (
    SELECT 1 FROM agents WHERE handle = 'agent-200w-reversion'
);

-- ---- Set the authoritative library fields (covers new + pre-existing) -----
UPDATE agents SET
    strategy          = 'ma_sniper',
    display_name      = '200-Week Sniper',
    description       = 'Buys quality companies only when they trade down to their '
                        '200-week average — and sits in cash until they do.',
    action            = 'buy',
    triggers          = '{}',
    available_for_hire = TRUE,
    is_house_agent    = TRUE,
    powered_by        = 'Rules-based',
    default_mandate   = NULL,
    param_schema      = '[
        {"key":"band_pct","label":"Buy within of 200w avg","type":"number","min":0,"max":25,"step":1,"unit":"%","default":5},
        {"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":5}
    ]'::jsonb,
    sentence_template =
        'Waits for quality names to trade down to their 200-week average, then '
        'buys within {band_pct}% of it — up to {target_position_pct}% per position.'
    WHERE handle = 'agent-200w-reversion';
