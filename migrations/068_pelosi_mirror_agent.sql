-- Migration 068: the Pelosi-mirror copy-trader (data tables + library agent).
--
-- Adds a "copy-trade a member of Congress" buyer. Two new tables hold the feed
-- and the per-portfolio dedup ledger; one new library agent (`agent-pelosi`)
-- is hireable onto a human portfolio's team and runs the `pelosi_mirror`
-- strategy (agent_strategies.py + pelosi_mirror.py).
--
-- Data flow: congress_trades.py ingests Nancy Pelosi's House Periodic
-- Transaction Reports into `congress_trades`; the heartbeat's `pelosi_mirror`
-- strategy reads the unmirrored ones, buys her purchases up to a settable
-- target weight and exits held names she sold, and records what it handled in
-- `congress_mirror_log` so re-runs only ever act on genuinely new filings.
--
-- Idempotent / paste-and-run in the Supabase SQL editor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- congress_trades: parsed disclosures (public, derived data) -----------
-- `ticker` is intentionally NOT FK'd to securities/companies: a disclosure can
-- name an equity outside our tradable universe and we still want the record;
-- the mirror simply can't price it and skips it.
CREATE TABLE IF NOT EXISTS congress_trades (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    politician          TEXT NOT NULL,            -- 'Nancy Pelosi'
    doc_id              TEXT NOT NULL,            -- House filing DocID
    filing_date         DATE,
    owner               TEXT,                     -- SP | JT | DC | self
    ticker              TEXT NOT NULL,            -- underlying common stock (even for options)
    asset_type          TEXT,                     -- ST | OP | OT | ...
    raw_txn_code        TEXT,                     -- P | S | S (partial) | E
    txn_type            TEXT NOT NULL,            -- 'buy' | 'sell' | 'other'
    txn_date            DATE,
    notification_date   DATE,
    amount_min          NUMERIC,                  -- disclosed dollar band (low)
    amount_max          NUMERIC,                  -- disclosed dollar band (high)
    is_option           BOOLEAN DEFAULT FALSE,
    is_gift             BOOLEAN DEFAULT FALSE,     -- charitable contribution / gift — not a market signal
    description         TEXT,
    source              TEXT DEFAULT 'house-clerk',
    fetched_at          TIMESTAMPTZ DEFAULT now(),
    -- sha256 of (politician|doc_id|ticker|code|date|owner|band) → re-ingesting
    -- the same filing is a no-op.
    dedupe_hash         TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS congress_trades_pol_date_idx
    ON congress_trades (politician, txn_date DESC);
CREATE INDEX IF NOT EXISTS congress_trades_doc_idx
    ON congress_trades (politician, doc_id);

ALTER TABLE congress_trades ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read congress_trades" ON congress_trades;
CREATE POLICY "public read congress_trades" ON congress_trades FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policy → writes are service-role only.

-- ---- congress_mirror_log: per-(portfolio, agent) handled-disclosure ledger -
-- One row per disclosure a mirror agent has acted on (or deliberately skipped)
-- for a given portfolio, so the strategy is idempotent and only mirrors NEW
-- filings. Like screener_rejections it can belong to a private portfolio →
-- service-role only (no public-read policy).
CREATE TABLE IF NOT EXISTS congress_mirror_log (
    portfolio_id        UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    congress_trade_id   UUID NOT NULL REFERENCES congress_trades(id) ON DELETE CASCADE,
    ticker              TEXT,
    action              TEXT,                     -- 'buy' | 'sell' | 'skip:<reason>'
    executed_at         TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (portfolio_id, agent_id, congress_trade_id)
);

ALTER TABLE congress_mirror_log ENABLE ROW LEVEL SECURITY;
-- No policies → service-role only (matches screener_rejections, migration 051).

-- ---- The hireable library agent -------------------------------------------
-- Function-first identity (brief §2): the NAME is the strategy. action='buy'
-- → heartbeat role 'buyer'; it's a *self-sourced* buyer (its candidates are
-- her disclosures, not the screen — see agent_strategies.SELF_SOURCED_BUYER_
-- STRATEGIES). Mechanical (no LLM), so default_mandate stays NULL (migration
-- 046 convention: no editable brief field for an engine that reads none).
INSERT INTO agents (
    handle, display_name, description, is_house_agent, available_for_hire,
    api_key_hash, api_key_prefix, powered_by, strategy,
    action, triggers, param_schema, sentence_template
)
SELECT
    'agent-pelosi', 'Pelosi Tracker',
    'Mirrors Nancy Pelosi''s disclosed stock trades — buys what she buys (the underlying stock even when she trades options) and sells held names she exits.',
    TRUE, TRUE, 'house-agent', 'ak_house_pl', 'Rules-based', 'pelosi_mirror',
    'buy', '{}',
    '[]'::jsonb, ''
WHERE NOT EXISTS (
    SELECT 1 FROM agents WHERE handle = 'agent-pelosi'
);

UPDATE agents SET
    strategy           = 'pelosi_mirror',
    display_name       = 'Pelosi Tracker',
    description        = 'Mirrors Nancy Pelosi''s disclosed stock trades — buys what she '
                         'buys (the underlying stock even when she trades options) and '
                         'sells held names she exits.',
    action             = 'buy',
    triggers           = '{}',
    available_for_hire = TRUE,
    is_house_agent     = TRUE,
    powered_by         = 'Rules-based',
    default_mandate    = NULL,
    param_schema       = '[
        {"key":"target_position_pct","label":"Target per position","type":"number","min":1,"max":15,"step":0.5,"unit":"%","default":5},
        {"key":"lookback_days","label":"Mirror trades disclosed within","type":"number","min":7,"max":365,"step":1,"unit":"days","default":60}
    ]'::jsonb,
    sentence_template  =
        'Copies Nancy Pelosi''s disclosed trades — buying her purchases up to '
        '{target_position_pct}% per name and selling names she exits, for '
        'filings from the last {lookback_days} days.'
    WHERE handle = 'agent-pelosi';
