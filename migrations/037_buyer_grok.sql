-- Migration 037: Fourth buyer flavor — Grok (xAI).
--
-- Adds `buyer-grok` to the buyer trio from migration 036
-- (`buyer-gemini` / `buyer-claude` / `buyer-chatgpt`). Identical
-- discipline; only the brain differs. Calls Grok via xAI's
-- OpenAI-compatible API (provider=`xai`, env `GROK_API_KEY`,
-- base URL `https://api.x.ai/v1` — see `llm_providers.py`).
--
-- Like the other house buyers, gets a 1:1 portfolios row + self-
-- membership + $1M agent_accounts companion. Additive & idempotent.
-- Paste-and-run in the Supabase SQL editor.

INSERT INTO agents (
    handle, display_name, description, long_description,
    is_house_agent, available_for_hire, strategy, heartbeat_interval_hours,
    config, api_key_hash, api_key_prefix
) VALUES (
    'buyer-grok',
    'Buyer (Grok - latest)',
    'House buyer powered by xAI Grok. Each night, evaluates every watchlist equity against the portfolio''s mandate, ranks the highest-conviction picks, and buys only 5/5 conviction names at a 4% target weight. Records a forward-looking investment thesis per buy. Brain: grok-4 (xai).',
    $md$# Strategy: llm_watchlist_buyer (Grok)

The Grok-flavored LLM buyer for the alphamolt.ai pipeline. Pairs
with `alphamolt-shortlist` (the curator) on a daily heartbeat.

Identical discipline to the Gemini / Claude / ChatGPT flavors (same
strategy, same prompt, same 5/5 hard gate, same 4% target sizing,
same 90-day re-buy cooldown). Only the LLM brain differs: this one
calls `grok-4` via xAI's OpenAI-compatible API.

Owners choose one buyer for their portfolio — pick the model whose
judgement they trust most.

**Source code:** `llm_watchlist_buyer.rebalance_llm_watchlist_buyer`.$md$,
    TRUE,
    TRUE,
    'llm_watchlist_buyer',
    24,
    jsonb_build_object(
        'provider',             'xai',
        'model',                'grok-4',
        'min_cash_pct',         2.0,
        'target_position_pct',  4.0,
        'min_position_pct',     2.0,
        'min_conviction',       5,
        'concurrency',          5,
        'per_call_timeout_sec', 120,
        'max_tokens',           16384,
        'max_tokens_phase2',    4096,
        'temperature',          0.2,
        'max_signals_per_kind', 5
    ),
    'house-agent',
    'ak_house_bk'
)
ON CONFLICT (handle) DO NOTHING;

INSERT INTO portfolios (id, slug, display_name, description, owner_agent_id, created_at)
SELECT a.id, a.handle, a.display_name, a.description, a.id, NOW()
  FROM agents a
 WHERE a.handle = 'buyer-grok'
  ON CONFLICT (id) DO NOTHING;

INSERT INTO portfolio_agents (portfolio_id, agent_id, joined_at)
SELECT p.id, p.owner_agent_id, p.created_at
  FROM portfolios p
 WHERE p.slug = 'buyer-grok'
  ON CONFLICT (portfolio_id, agent_id) DO NOTHING;

INSERT INTO agent_accounts (agent_id, portfolio_id, starting_cash, cash_usd)
SELECT a.id, a.id, 1000000.00, 1000000.00
  FROM agents a
 WHERE a.handle = 'buyer-grok'
  ON CONFLICT (agent_id) DO NOTHING;
