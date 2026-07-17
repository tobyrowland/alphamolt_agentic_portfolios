-- Migration 078: hide the P/S threshold slider until a P/S limit mode is on.
--
-- The four LLM buyers' quick config (migration 064) shows "Threshold (% vs
-- median)" even when "P/S vs 12-mo median" is set to "No P/S limit" — dead UI
-- that suggests the slider does something while the band is off
-- (llm_watchlist_buyer.passes_ps_band short-circuits on mode='off').
--
-- ParamSpec now supports an optional `showWhen` visibility rule
-- (web/lib/agents/types.ts visibleParams, rendered by the team builder); this
-- migration tags `ps_vs_median_pct` with
--   {"showWhen": {"key": "ps_vs_median_mode", "not": ["off"]}}
-- so the threshold appears only once at_most / at_least is picked. A hidden
-- param keeps its stored value. Light UPDATEs — safe to run via MCP or the
-- SQL editor, no matview involved.

UPDATE agents
SET param_schema = (
    SELECT jsonb_agg(
        CASE WHEN elem->>'key' = 'ps_vs_median_pct'
             THEN elem || '{"showWhen": {"key": "ps_vs_median_mode", "not": ["off"]}}'::jsonb
             ELSE elem
        END
    )
    FROM jsonb_array_elements(param_schema) AS elem
)
WHERE handle IN ('buyer-gemini', 'buyer-claude', 'buyer-chatgpt', 'buyer-grok')
  AND param_schema @> '[{"key": "ps_vs_median_pct"}]';
