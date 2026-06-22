-- Migration 063: backfill securities.price from EOD close (price coverage fix).
--
-- The "current price" canary (securities.price) sat at ~30% coverage
-- (943/3128) because it was only ever seeded from the legacy companies backfill
-- (migration 058) and the 15-min intraday feed only returns the liquid subset.
-- Every Tier-1 name DOES have an EOD close in prices_daily, so this one-off
-- fills the canary from the latest close for names missing it (~2,185).
--
-- Going forward prices_daily_updater.daily_increment stamps securities.price
-- from the EOD close for the whole Tier-1 set daily, and intraday_prices
-- overlays the liquid subset with fresher quotes — so coverage stays ~100%.
--
-- Safe + idempotent: only fills NULLs, so it never clobbers a fresher
-- intraday/backfilled quote. Re-running is a no-op once filled.

UPDATE securities s
   SET price      = lp.close,
       price_asof = (lp.date + TIME '20:00')::timestamptz
  FROM (
        SELECT DISTINCT ON (ticker) ticker, close, date
          FROM prices_daily
         ORDER BY ticker, date DESC
       ) lp
 WHERE lp.ticker = s.ticker
   AND s.is_tier1
   AND s.price IS NULL
   AND lp.close IS NOT NULL;
