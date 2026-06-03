-- Migration 036: Three model-flavored Buyer house agents.
--
-- The existing `buying-agent` is renamed to `buyer-gemini` and gets a
-- new display name "Buyer (Gemini - latest)". Two parallel buyer
-- agents are added — `buyer-claude` (Claude Opus 4.8) and
-- `buyer-chatgpt` (GPT-5) — each running the same `llm_watchlist_buyer`
-- strategy but configured to call a different frontier model. Portfolio
-- owners can add any one of the three to their portfolio depending on
-- which model they want making buy decisions.
--
-- All three are public house agents (`is_house_agent=true`,
-- `available_for_hire=true`). They share the same buyer discipline:
-- per-ticker LLM evaluation against the portfolio mandate, hard 5/5
-- conviction gate, ranked Phase 2 prioritisation, 4% target per
-- position, 90-day re-buy cooldown.
--
-- Like the other house agents (migrations 028 + 032), each gets the
-- standard 1:1 portfolios row + portfolio_agents self-membership +
-- agent_accounts row.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.


-- ============================================================
-- 1. Rename buying-agent → buyer-gemini
-- ============================================================
-- The strategy stays `llm_watchlist_buyer`. Only handle, display name,
-- and description change. The UUID (and every relation keyed on it —
-- portfolio_agents memberships, agent_trades, investment_theses) is
-- preserved.

UPDATE agents
   SET handle = 'buyer-gemini',
       display_name = 'Buyer (Gemini - latest)',
       description = 'House buyer powered by Google Gemini. Each night, evaluates every watchlist equity against the portfolio''s mandate, ranks the highest-conviction picks, and buys only 5/5 conviction names at a 4% target weight. Records a forward-looking investment thesis per buy. Brain: gemini-2.5-pro (google).',
       long_description = $md$# Strategy: llm_watchlist_buyer (Gemini)

The Gemini-flavored LLM buyer for the alphamolt.ai pipeline. Pairs
with `alphamolt-shortlist` (the curator) on a daily heartbeat.

Identical discipline to the Claude and ChatGPT flavors (same
strategy, same prompt, same 5/5 hard gate, same 4% target sizing,
same 90-day re-buy cooldown). Only the LLM brain differs: this one
calls `gemini-2.5-pro` via Google's Generative AI API.

Owners choose one buyer for their portfolio — pick the model whose
judgement they trust most.

**Source code:** `llm_watchlist_buyer.rebalance_llm_watchlist_buyer`.$md$,
       config = jsonb_set(
                  jsonb_set(
                    COALESCE(config, '{}'::jsonb),
                    '{provider}', '"google"'::jsonb
                  ),
                  '{model}', '"gemini-2.5-pro"'::jsonb
                ),
       updated_at = NOW()
 WHERE handle = 'buying-agent';

-- Re-slug the 1:1 portfolio to match the new handle.
UPDATE portfolios p
   SET slug = a.handle,
       display_name = a.display_name,
       description = a.description,
       updated_at = NOW()
  FROM agents a
 WHERE a.handle = 'buyer-gemini'
   AND p.id = a.id;


-- ============================================================
-- 2. New buyer: Claude (Opus 4.8)
-- ============================================================

INSERT INTO agents (
    handle, display_name, description, long_description,
    is_house_agent, available_for_hire, strategy, heartbeat_interval_hours,
    config, api_key_hash, api_key_prefix
) VALUES (
    'buyer-claude',
    'Buyer (Claude - latest)',
    'House buyer powered by Anthropic Claude. Each night, evaluates every watchlist equity against the portfolio''s mandate, ranks the highest-conviction picks, and buys only 5/5 conviction names at a 4% target weight. Records a forward-looking investment thesis per buy. Brain: claude-opus-4-8 (anthropic).',
    $md$# Strategy: llm_watchlist_buyer (Claude)

The Claude-flavored LLM buyer for the alphamolt.ai pipeline. Pairs
with `alphamolt-shortlist` (the curator) on a daily heartbeat.

Identical discipline to the Gemini and ChatGPT flavors (same
strategy, same prompt, same 5/5 hard gate, same 4% target sizing,
same 90-day re-buy cooldown). Only the LLM brain differs: this one
calls `claude-opus-4-8` via Anthropic's API.

Owners choose one buyer for their portfolio — pick the model whose
judgement they trust most.

**Source code:** `llm_watchlist_buyer.rebalance_llm_watchlist_buyer`.$md$,
    TRUE,
    TRUE,
    'llm_watchlist_buyer',
    24,
    jsonb_build_object(
        'provider',             'anthropic',
        'model',                'claude-opus-4-8',
        'min_cash_pct',         2.0,
        'target_position_pct',  4.0,
        'min_position_pct',     2.0,
        'min_conviction',       5,
        'concurrency',          5,
        'per_call_timeout_sec', 120,
        'max_tokens',           8192,
        'max_tokens_phase2',    4096,
        'temperature',          0.2,
        'max_signals_per_kind', 5
    ),
    'house-agent',
    'ak_house_bc'
)
ON CONFLICT (handle) DO NOTHING;

INSERT INTO portfolios (id, slug, display_name, description, owner_agent_id, created_at)
SELECT a.id, a.handle, a.display_name, a.description, a.id, NOW()
  FROM agents a
 WHERE a.handle = 'buyer-claude'
  ON CONFLICT (id) DO NOTHING;

INSERT INTO portfolio_agents (portfolio_id, agent_id, joined_at)
SELECT p.id, p.owner_agent_id, p.created_at
  FROM portfolios p
 WHERE p.slug = 'buyer-claude'
  ON CONFLICT (portfolio_id, agent_id) DO NOTHING;

INSERT INTO agent_accounts (agent_id, portfolio_id, starting_cash, cash_usd)
SELECT a.id, a.id, 1000000.00, 1000000.00
  FROM agents a
 WHERE a.handle = 'buyer-claude'
  ON CONFLICT (agent_id) DO NOTHING;


-- ============================================================
-- 3. New buyer: ChatGPT (GPT-5)
-- ============================================================

INSERT INTO agents (
    handle, display_name, description, long_description,
    is_house_agent, available_for_hire, strategy, heartbeat_interval_hours,
    config, api_key_hash, api_key_prefix
) VALUES (
    'buyer-chatgpt',
    'Buyer (ChatGPT - latest)',
    'House buyer powered by OpenAI ChatGPT. Each night, evaluates every watchlist equity against the portfolio''s mandate, ranks the highest-conviction picks, and buys only 5/5 conviction names at a 4% target weight. Records a forward-looking investment thesis per buy. Brain: gpt-5 (openai).',
    $md$# Strategy: llm_watchlist_buyer (ChatGPT)

The ChatGPT-flavored LLM buyer for the alphamolt.ai pipeline. Pairs
with `alphamolt-shortlist` (the curator) on a daily heartbeat.

Identical discipline to the Gemini and Claude flavors (same strategy,
same prompt, same 5/5 hard gate, same 4% target sizing, same 90-day
re-buy cooldown). Only the LLM brain differs: this one calls `gpt-5`
via OpenAI's API. The OpenAI provider in `llm_providers.py` knows to
use `max_completion_tokens` (vs. `max_tokens`) for the gpt-5 / o-series
family.

Owners choose one buyer for their portfolio — pick the model whose
judgement they trust most.

**Source code:** `llm_watchlist_buyer.rebalance_llm_watchlist_buyer`.$md$,
    TRUE,
    TRUE,
    'llm_watchlist_buyer',
    24,
    jsonb_build_object(
        'provider',             'openai',
        'model',                'gpt-5',
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
    'ak_house_bg'
)
ON CONFLICT (handle) DO NOTHING;

INSERT INTO portfolios (id, slug, display_name, description, owner_agent_id, created_at)
SELECT a.id, a.handle, a.display_name, a.description, a.id, NOW()
  FROM agents a
 WHERE a.handle = 'buyer-chatgpt'
  ON CONFLICT (id) DO NOTHING;

INSERT INTO portfolio_agents (portfolio_id, agent_id, joined_at)
SELECT p.id, p.owner_agent_id, p.created_at
  FROM portfolios p
 WHERE p.slug = 'buyer-chatgpt'
  ON CONFLICT (portfolio_id, agent_id) DO NOTHING;

INSERT INTO agent_accounts (agent_id, portfolio_id, starting_cash, cash_usd)
SELECT a.id, a.id, 1000000.00, 1000000.00
  FROM agents a
 WHERE a.handle = 'buyer-chatgpt'
  ON CONFLICT (agent_id) DO NOTHING;
