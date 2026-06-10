-- Migration 049: the 200-week average sniper becomes a real mechanical agent.
--
-- A version of Charlie Munger's "sit on your hands until the fat pitch" sniper:
-- wait for a QUALITY business to trade down to its long-run trend (the 200-week
-- moving average), then strike. The seeded `agent-200w-reversion` (migration
-- 045/046) only ever described this — it was wired to the generic LLM buyer
-- (`llm_watchlist_buyer`), an LLM reading a prose brief, with NO actual access
-- to a 200-week average. This migration points it at the real `ma_sniper`
-- engine (ma_sniper.py + agent_strategies.rebalance_ma_sniper), which sources
-- per-name conviction from each candidate's distance to its 200-week MA.
--
-- Quality is already supplied upstream: the candidate set is the top N of the
-- portfolio's screen (quality-weighted), so the agent only has to answer "is it
-- on sale vs its own 200-week average?". Sizing/gate params map onto the
-- strategy's config keys the heartbeat reads on the swarm path.
--
-- Mechanical (no LLM brain): `powered_by` becomes 'Rules-based' and, per the
-- migration-046 convention, `default_mandate` is cleared to NULL so the team
-- builder shows no editable brief field for it (a brief no engine reads).
--
-- Idempotent. Paste-and-run in the Supabase SQL editor.

UPDATE agents SET
    strategy          = 'ma_sniper',
    display_name      = '200-Week Sniper',
    description       = 'Buys quality companies only when they trade down to their '
                        '200-week average — and sits in cash until they do.',
    action            = 'buy',
    available_for_hire = TRUE,
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
