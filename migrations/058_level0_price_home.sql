-- Migration 058: Level 0 current-price home (companies retirement, phase 0).
--
-- The legacy `companies.price` / `companies.price_asof` is the ONLY home for the
-- live/intraday quote that drives trade pricing and mark-to-market. Level 0's
-- `prices_daily` is end-of-day only. To retire `companies`, the "latest known
-- price" concept must move into Level 0 first.
--
-- This adds `price` + `price_asof` to `securities` (the Tier 0 identity table,
-- the FK target the whole trading layer will repoint to). Semantics mirror
-- `companies.price` exactly: the most recent quote we have — intraday during US
-- market hours (written by intraday_prices.py), rolling forward to the prior
-- close otherwise. `last_close` (weekly gate input) is unchanged and kept.
--
-- Additive + idempotent. Safe to run on the live DB before any reader/writer is
-- repointed: nothing reads these columns yet.

ALTER TABLE securities ADD COLUMN IF NOT EXISTS price       NUMERIC(14,4);
ALTER TABLE securities ADD COLUMN IF NOT EXISTS price_asof  TIMESTAMPTZ;

-- One-time backfill from the legacy table so MTM is correct the moment the
-- readers flip to Level 0 (before the daily/intraday jobs have run on the new
-- path). Only copies a usable positive price.
UPDATE securities s
   SET price      = c.price,
       price_asof = c.price_asof
  FROM companies c
 WHERE c.ticker = s.ticker
   AND c.price IS NOT NULL
   AND c.price > 0;
