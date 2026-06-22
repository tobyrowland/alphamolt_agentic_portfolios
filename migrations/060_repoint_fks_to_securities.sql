-- Migration 060: repoint foreign keys off companies (companies retirement, phase 3).
--
-- The authoritative catalog shows only THREE live FKs reference companies(ticker):
--   * consensus_snapshots.ticker  (ON DELETE CASCADE)
--   * portfolio_watchlist.ticker  (no action)
--   * price_sales.ticker          (ON DELETE CASCADE)  -- handled at table retirement
-- (agent_trades / agent_holdings / investment_theses carry NO companies FK in
-- production despite older schema text, so nothing there blocks the drop.)
--
-- This repoints the two we keep onto securities(ticker) — the Level 0 identity
-- table — so companies can be retired:
--   * portfolio_watchlist -> securities  (verified 0 orphan tickers).
--   * consensus_snapshots -> drop the FK entirely. It's a derived weekly
--     snapshot keyed on whatever agents held; its tickers can legitimately be
--     delisted names absent from securities (11 such today), and the data is
--     already validated upstream, so an FK adds risk without integrity value.
--
-- price_sales' FK is left until migration 061 renames companies + price_sales
-- together (a FK between two soon-to-be *_legacy tables is harmless meanwhile).
--
-- Idempotent. Safe to apply independently.

-- consensus_snapshots: drop the companies FK (no repoint).
ALTER TABLE consensus_snapshots
    DROP CONSTRAINT IF EXISTS consensus_snapshots_ticker_fkey;

-- portfolio_watchlist: repoint to securities.
ALTER TABLE portfolio_watchlist
    DROP CONSTRAINT IF EXISTS portfolio_watchlist_ticker_fkey;
ALTER TABLE portfolio_watchlist
    ADD CONSTRAINT portfolio_watchlist_ticker_fkey
    FOREIGN KEY (ticker) REFERENCES securities(ticker);
