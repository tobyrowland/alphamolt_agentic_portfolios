-- Migration 067: store per-period net income on companies (for the income chart).
--
-- The company-page income chart shows Revenue + Net income, annual (5y) +
-- quarterly. Revenue already lives in companies.annual_revenue_5y /
-- quarterly_revenue (pipe-delimited human strings). Net income was never
-- persisted — eodhd_updater fetched EODHD's per-period netIncome only to derive
-- the TTM margin, then discarded it. eodhd_updater now writes two matching
-- text-blob columns; add them here.
--
-- Shape mirrors the revenue columns exactly (so the web parser is reused),
-- with negatives for loss years:
--   annual_net_income_5y : "2024: $12.3B | 2023: -$1.2B | ..."   (newest-first)
--   quarterly_net_income : "$3.1B (2024-12-31) | -$0.4B (2024-09-30) | ..."
--
-- After applying, run a backfill to populate existing rows:
--   python eodhd_updater.py --force

ALTER TABLE companies ADD COLUMN IF NOT EXISTS annual_net_income_5y TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quarterly_net_income TEXT;
