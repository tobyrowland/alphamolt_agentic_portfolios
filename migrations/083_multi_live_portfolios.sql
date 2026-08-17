-- Migration 083: several live portfolios sharing one broker account ("sleeves").
--
-- Migration 070 allowed up to 5 paper portfolios per user but kept the live
-- follower strictly one-per-user. That cap existed because a live portfolio was
-- assumed to BE its broker account: the mirror sized positions off the whole
-- account equity and diffed them against the whole account's positions.
--
-- Two live portfolios under that assumption would destroy each other — each
-- would see the other's positions as drift and sell them, every run, with real
-- money. So the code changes in this migration's companion commit are what make
-- the cap safe to lift:
--
--   * the mirror now plans against a live portfolio's OWN recorded holdings and
--     OWN equity (holdings + its cash allowance), never the broker aggregate, so
--     two sleeves are invisible to each other;
--   * broker_sync refuses to overwrite the book when an account is shared (the
--     overwrite would collapse the per-sleeve split) and reconciles instead;
--   * every fill is booked to the portfolio that ordered it.
--
-- The money model: the BROKER holds one pot of cash. Each live portfolio holds
-- an *allowance* (portfolio_accounts.cash_usd) that the owner credits to it, and
-- may only spend that. Dividends / interest / fees land in the broker's cash and
-- are simply unallocated until the owner credits them out — no attribution, by
-- design (on a growth-equity book they are immaterial). Sale proceeds return to
-- the selling portfolio's own allowance.
--
-- Invariants the code checks (and refuses to trade on violation):
--     SUM(sleeve holdings per symbol) == broker position for that symbol
--     SUM(sleeve allowances)          <= broker cash
--
-- Idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. Lift the one-live-per-user cap
-- ============================================================
-- Live portfolios are created by an operator script (bootstrap_live_portfolio.py),
-- never by an end user through the website, so there is no user-facing RPC to
-- put a count-based cap in (unlike migration 070's paper cap in
-- create_portfolio_funded). The practical limit is how many broker accounts and
-- allowances the owner actually funds.
DROP INDEX IF EXISTS idx_portfolios_one_live_per_user;

-- Keep live-portfolio lookups by owner fast now that the unique index is gone.
CREATE INDEX IF NOT EXISTS idx_portfolios_owner_live
    ON portfolios (owner_user_id)
    WHERE owner_user_id IS NOT NULL AND mode = 'live';

-- ============================================================
-- 2. Which broker account a live portfolio trades through
-- ============================================================
-- Credentials are resolved from the ALPACA_ACCOUNTS secret, which is keyed by
-- string. Until now that key was implicitly the portfolio's slug, which made
-- "two portfolios, one account" inexpressible without duplicating credentials
-- under two keys.
--
-- broker_account_key names the entry explicitly. Two live portfolios carrying
-- the SAME key are declared sleeves of one account — which is also how the
-- anti-commingle guard tells deliberate sharing apart from an accident.
-- NULL keeps the old behaviour (fall back to the slug), so existing live
-- portfolios are unaffected.
ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS broker_account_key TEXT;

COMMENT ON COLUMN portfolios.broker_account_key IS
    'For mode=''live'' rows: which broker-credentials entry this portfolio '
    'trades through (key into the ALPACA_ACCOUNTS secret). Two live rows with '
    'the same key are sleeves of ONE account and share its cash. NULL falls '
    'back to the portfolio slug (pre-083 behaviour). Never holds a credential.';

CREATE INDEX IF NOT EXISTS idx_portfolios_broker_account_key
    ON portfolios (broker_account_key)
    WHERE broker_account_key IS NOT NULL;

-- ============================================================
-- 3. Audit trail for allowance movements
-- ============================================================
-- Crediting cash to a sleeve moves real spending power, so every movement is
-- recorded and a balance can always be explained. Not a trade journal —
-- agent_trades already covers trades; this covers only owner-initiated
-- allowance changes (credit / debit / transfer legs).
CREATE TABLE IF NOT EXISTS portfolio_cash_ledger (
    id            BIGSERIAL PRIMARY KEY,
    portfolio_id  UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    delta_usd     NUMERIC NOT NULL,
    balance_after NUMERIC,
    reason        TEXT NOT NULL,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE portfolio_cash_ledger IS
    'Owner-initiated allowance movements for live portfolios (credit / debit / '
    'transfer legs). delta_usd is signed. Service-role only — an allowance can '
    'belong to a private portfolio.';

CREATE INDEX IF NOT EXISTS idx_portfolio_cash_ledger_portfolio
    ON portfolio_cash_ledger (portfolio_id, created_at DESC);

ALTER TABLE portfolio_cash_ledger ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (same rule as screener_rejections /
-- congress_mirror_log — the row can belong to a private portfolio).

-- ============================================================
-- 4. House agent for mirror-placed fills
-- ============================================================
-- A mirror order isn't any agent's decision — it's the follower tracking its
-- paper book. Fills still need an agent_id for agent_trades, so attribute them
-- to a dedicated house agent rather than borrowing 'manual' (owner-initiated)
-- and muddying the trade tape.
INSERT INTO agents (handle, display_name, description, is_house_agent,
                    strategy, powered_by, available_for_hire)
VALUES (
    'live-mirror',
    'Live Mirror',
    'Places the real broker orders that keep a live follower portfolio matching '
    'the paper portfolio it tracks. Not a strategy — it makes no decisions of '
    'its own; the paper book''s agents do that.',
    TRUE,
    NULL,          -- no strategy: never picked up by the heartbeat agent pass
    'Rules-based',
    FALSE          -- not hireable
)
ON CONFLICT (handle) DO NOTHING;
