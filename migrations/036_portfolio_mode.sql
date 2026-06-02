-- Migration 036: per-portfolio paper/live mode (owner-only secret)
--
-- Adds `portfolios.mode` so a single portfolio can be backed by a real
-- broker account (Alpaca — see alpaca_client.py / alpaca_execution.py)
-- while everything else about it behaves like a normal paper portfolio.
--
-- VISIBILITY CONTRACT — read before touching any portfolio read path:
--   `mode` is OWNER-ONLY. The portfolio itself stays fully visible under
--   the existing rules (is_public + the 15/10-equity hysteresis); only the
--   *fact that it is real money* is hidden. To everyone but the owner the
--   portfolio must be indistinguishable from a paper one.
--
--   This is enforced at the QUERY LAYER, not by RLS: public portfolio rows
--   are world-readable (anon key) and the website reads with the
--   service-role key, so column-level hiding can't come from RLS. The rule
--   is therefore: NEVER select `mode` on a code path whose result can reach
--   a non-owner. Public reads (web/lib/portfolios-query.ts) use an explicit
--   column list that excludes `mode`; the owner-only marker reads it via the
--   dedicated `getPortfolioMode(portfolioId, ownerUserId)` accessor.
--
--   'live' is what the Alpaca reconcile loop keys on to decide a portfolio's
--   normal-table writes are mirrored from real fills rather than paper.

ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'paper';

ALTER TABLE portfolios
    DROP CONSTRAINT IF EXISTS chk_portfolios_mode;
ALTER TABLE portfolios
    ADD CONSTRAINT chk_portfolios_mode CHECK (mode IN ('paper', 'live'));

COMMENT ON COLUMN portfolios.mode IS
    'paper | live. OWNER-ONLY — never expose to non-owners (query-layer '
    'enforced; see migration 036). live = backed by a real Alpaca account.';
