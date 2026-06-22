-- Migration 064: Buyer — settable conviction + P/S-discount value gate; rename.
--
-- The "Conviction Buyer" family (four brains on one strategy, llm_watchlist_buyer)
-- becomes simply "Buyer", with two newly-exposed team-builder controls beside the
-- existing position-size slider:
--
--   * min_conviction        — the conviction gate (1-5). The engine ALREADY reads
--                             this (cfg.convictionGate || min_conviction); migration
--                             047 just never surfaced it. Default stays 5.
--   * min_ps_discount_pct   — synchronous value gate: only buy a name trading at
--                             least N% below its own 12-month P/S median. 0 = OFF
--                             (exact current behaviour). When > 0, names with no
--                             usable P/S median are EXCLUDED. See passes_value_gate
--                             in llm_watchlist_buyer.py.
--
-- AND'd together, the two knobs let one Buyer "pay up" for top-fit names and another
-- demand a discount for lower-conviction ones — the conviction<->price trade-off,
-- composed across the swarm. Conviction is now a dial, so "Conviction Buyer" is
-- renamed "Buyer".
--
-- Only the library-presentation columns change; UUIDs / portfolios / track records
-- are untouched. Idempotent per-handle UPDATEs (mirror of migration 047).
-- Paste-and-run in the Supabase SQL editor.

-- ---- The four LLM buyers: rename + expose the two knobs ---------------------
UPDATE agents SET
    display_name      = 'Buyer · Gemini',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"min_ps_discount_pct","label":"Min discount to TTM P/S median","type":"number","min":0,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position — and only at a discount of {min_ps_discount_pct}% or more to its 12-month P/S median.'
    WHERE handle = 'buyer-gemini';

UPDATE agents SET
    display_name      = 'Buyer · Claude',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"min_ps_discount_pct","label":"Min discount to TTM P/S median","type":"number","min":0,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position — and only at a discount of {min_ps_discount_pct}% or more to its 12-month P/S median.'
    WHERE handle = 'buyer-claude';

UPDATE agents SET
    display_name      = 'Buyer · GPT-5',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"min_ps_discount_pct","label":"Min discount to TTM P/S median","type":"number","min":0,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position — and only at a discount of {min_ps_discount_pct}% or more to its 12-month P/S median.'
    WHERE handle = 'buyer-chatgpt';

UPDATE agents SET
    display_name      = 'Buyer · Grok',
    param_schema      = '[{"key":"target_position_pct","label":"Target per position","type":"number","min":2,"max":10,"step":0.5,"unit":"%","default":4},{"key":"min_conviction","label":"Minimum conviction to buy","type":"number","min":1,"max":5,"step":1,"default":5},{"key":"min_ps_discount_pct","label":"Min discount to TTM P/S median","type":"number","min":0,"max":40,"step":1,"unit":"%","default":0}]'::jsonb,
    sentence_template = 'Weighs every candidate against your brief and buys only names at conviction {min_conviction}/5 or higher, up to {target_position_pct}% per position — and only at a discount of {min_ps_discount_pct}% or more to its 12-month P/S median.'
    WHERE handle = 'buyer-grok';
