-- Migration 082: name the broker a live portfolio trades through.
--
-- The live path was built against one broker (Alpaca) and hard-imported it at
-- every call site. It now runs against the `broker.BrokerBackend` protocol, so
-- a portfolio needs to say WHICH broker its account lives at. That is this
-- column.
--
-- Only meaningful for mode='live' rows (a paper portfolio trades the simulated
-- book and never touches a broker); harmless and ignored on paper rows.
--
-- Deliberately NOT constrained by a CHECK against a fixed broker list: the set
-- of supported brokers is a property of the CODE (broker._BACKEND_FACTORIES),
-- not the schema. An unrecognised value raises a clear BrokerError at resolve
-- time rather than needing a migration to move in lockstep with each new
-- backend.
--
-- Behaviour-preserving: DEFAULT 'alpaca' and the reader
-- (broker.broker_for_portfolio) also defaults to 'alpaca' when the column is
-- absent or NULL, so existing live portfolios keep routing exactly as before —
-- and the code works whether or not this migration has been applied.
--
-- Idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. The column
-- ============================================================
ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS broker TEXT NOT NULL DEFAULT 'alpaca';

COMMENT ON COLUMN portfolios.broker IS
    'Broker a live portfolio executes through (e.g. alpaca). Resolved by '
    'broker.resolve_backend_for_portfolio; validated in code against the '
    'registered backends, not by a CHECK constraint. Ignored for paper '
    'portfolios. Credentials are never stored here — they come from the '
    'per-broker env secret (e.g. ALPACA_ACCOUNTS keyed by live slug).';

-- ============================================================
-- 2. Backfill (no-op on a fresh apply — the DEFAULT covers new + existing
--    rows; explicit for any row that predates the default with a NULL).
-- ============================================================
UPDATE portfolios SET broker = 'alpaca' WHERE broker IS NULL;
