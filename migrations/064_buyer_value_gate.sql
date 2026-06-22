-- Migration 064: Buyer — settable conviction + optional P/S-vs-median band; rename.
--
-- The "Conviction Buyer" family (four brains on one strategy, llm_watchlist_buyer)
-- becomes simply "Buyer", with newly-exposed team-builder controls beside the
-- existing position-size slider:
--
--   * min_conviction       — the conviction gate (1-5). The engine ALREADY reads
--                            this (cfg.convictionGate || min_conviction); migration
--                            047 just never surfaced it. Default stays 5.
--   * ps_vs_median_mode    — optional, two-directional P/S-vs-median band:
--       + ps_vs_median_pct    off       no valuation constraint (default).
--                             at_most   buy only if ps <= median*(1 + pct/100)
--                                       (ceiling / don't-overpay; pct signed —
--                                       negative demands a discount, positive
--                                       tolerates a premium).
--                             at_least  buy only if ps >= median*(1 + pct/100)
--                                       (floor / "double-positive" premium).
--                            When engaged, names with no usable P/S median are
--                            EXCLUDED. See passes_ps_band in llm_watchlist_buyer.py.
--
-- AND'd with the conviction gate, the knobs let one Buyer "pay up" for top-fit names
-- and another demand value — the conviction<->price trade-off, composed across the
-- swarm. Conviction is now a dial, so "Conviction Buyer" is renamed "Buyer". The
-- valuation rule is deliberately kept OUT of sentence_template (static interpolation
-- can't drop a clause when off) — the labelled controls express it instead.
--
-- Only the library-presentation columns change; UUIDs / portfolios / track records
-- are untouched. Idempotent per-handle UPDATEs (mirror of migration 047).
-- Paste-and-run in the Supabase SQL editor.

-- The shared schema/sentence (same for all four brains).
--   param_schema:
--     [ target_position_pct (number 2-10),
--       min_conviction (number 1-5),
--       ps_vs_median_mode (select off|at_most|at_least),
--       ps_vs_median_pct (number -40..+40, signed) ]

UPDATE agents SET
    display_name      = 'Buyer · Gemini',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"ps_vs_median_mode","label":"P/S vs 12-mo median","type":"select","default":"off","options":[{"value":"off","label":"No P/S limit"},{"value":"at_most","label":"Buy only at/below threshold"},{"value":"at_least","label":"Buy only at/above threshold"}]},{"key":"ps_vs_median_pct","label":"Threshold (% vs median)","type":"number","min":-40,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position.'
    WHERE handle = 'buyer-gemini';

UPDATE agents SET
    display_name      = 'Buyer · Claude',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"ps_vs_median_mode","label":"P/S vs 12-mo median","type":"select","default":"off","options":[{"value":"off","label":"No P/S limit"},{"value":"at_most","label":"Buy only at/below threshold"},{"value":"at_least","label":"Buy only at/above threshold"}]},{"key":"ps_vs_median_pct","label":"Threshold (% vs median)","type":"number","min":-40,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position.'
    WHERE handle = 'buyer-claude';

UPDATE agents SET
    display_name      = 'Buyer · GPT-5',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"ps_vs_median_mode","label":"P/S vs 12-mo median","type":"select","default":"off","options":[{"value":"off","label":"No P/S limit"},{"value":"at_most","label":"Buy only at/below threshold"},{"value":"at_least","label":"Buy only at/above threshold"}]},{"key":"ps_vs_median_pct","label":"Threshold (% vs median)","type":"number","min":-40,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position.'
    WHERE handle = 'buyer-chatgpt';

UPDATE agents SET
    display_name      = 'Buyer · Grok',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"ps_vs_median_mode","label":"P/S vs 12-mo median","type":"select","default":"off","options":[{"value":"off","label":"No P/S limit"},{"value":"at_most","label":"Buy only at/below threshold"},{"value":"at_least","label":"Buy only at/above threshold"}]},{"key":"ps_vs_median_pct","label":"Threshold (% vs median)","type":"number","min":-40,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position.'
    WHERE handle = 'buyer-grok';
