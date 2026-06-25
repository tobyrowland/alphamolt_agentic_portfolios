-- Migration 067: per-period revenue + net income on Level 0 `fundamentals`
-- (for the company-page income chart).
--
-- `companies` was retired in migration 061 (renamed to companies_legacy), so the
-- revenue text-blob series lost its home and net income was never stored. Put
-- both on the live Level 0 `fundamentals` table instead — written by the live
-- ingester (fundamentals_updater.py, which already calls eodhd_updater.
-- fetch_eodhd_data) onto the latest period_end row, and read per-ticker by the
-- company page.
--
-- Pipe-delimited human strings, newest-first, negatives for loss periods (so the
-- existing web parser is reused):
--   annual_revenue_5y    : "2024: $125.3B | 2023: $118.4B | ..."
--   quarterly_revenue    : "$35.2B (2024-12-31) | $32.1B (2024-09-30) | ..."
--   annual_net_income_5y : "2024: $12.3B | 2023: -$1.2B | ..."
--   quarterly_net_income : "$3.1B (2024-12-31) | -$0.4B (2024-09-30) | ..."
--
-- After applying, backfill via the live fundamentals path:
--   python fundamentals_updater.py --force      # or backfill_tier1_fundamentals.py

ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS annual_revenue_5y TEXT;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS quarterly_revenue TEXT;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS annual_net_income_5y TEXT;
ALTER TABLE fundamentals ADD COLUMN IF NOT EXISTS quarterly_net_income TEXT;
