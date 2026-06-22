-- Migration 059: legacy cleanup — drop dead back-compat schema.
--
-- All verified unread before dropping (no view/RPC/app reader):
--   1. portfolios.launched_at + launch_portfolio() RPC — the draft→launch flow
--      was removed in migration 031 (create_portfolio_funded funds on creation).
--      CLAUDE.md / migration 031 flagged these as "kept for back-compat, drop
--      later". Confirmed: zero readers in app code; no view depends on the
--      column (information_schema.view_column_usage empty).
--   2. portfolios.draft_config — the swarm "Run as a swarm" toggle (migration
--      041) was removed; the swarm now runs for any portfolio with role-tagged
--      buyers. Written by setDraftConfig() (now deleted) but never read.
--
-- NOTE: the universe-snapshot stack (universe_snapshots / build_universe_
-- snapshot.py / llm_picker.py) is intentionally NOT dropped here — it is still
-- consumed by the live portfolio_reviewer (reads the extended snapshot via
-- _load_latest_snapshot). Retiring it requires migrating the reviewer to
-- Level 0 first (a separate change).

-- 1. launch_portfolio RPC (both signatures, defensive) + launched_at column
DROP FUNCTION IF EXISTS launch_portfolio(UUID);
DROP FUNCTION IF EXISTS launch_portfolio();
ALTER TABLE portfolios DROP COLUMN IF EXISTS launched_at;

-- 2. draft_config column
ALTER TABLE portfolios DROP COLUMN IF EXISTS draft_config;
