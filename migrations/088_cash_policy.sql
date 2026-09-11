-- Migration 088: owner-configured CASH POLICY (`portfolios.cash_policy`).
--
-- WHY. A portfolio's buyers share one cash pool, and nothing allocated it
-- between them. Observed on the "Scrappy Fightback!" book: the swarm runs
-- self-sourced buyers (double_down) BEFORE the snake draft, and the draft then
-- buys until cash reaches its floor. So the draft always left ~2%, and the
-- Double-Down Buyer always arrived to find ~2% — it made ZERO trades in its
-- entire life while the screen buyer made 25 on the same book.
--
-- `swarm.snake_draft_plan` has always accepted a `cash_reserve_pct`, and the
-- heartbeat has always let it default to 2%. This migration is the missing
-- half: somewhere for the OWNER to set that number.
--
-- WHY PORTFOLIO-LEVEL, not an agent knob (the same argument as migration 086).
-- Per-agent settings live in `portfolio_agents.config` and reach exactly one
-- member. "Leave room for the other agents" is a rule about the SHARED POT: on
-- one buyer's config it would bind only that buyer, be silently ignored the day
-- a second screen-buyer is hired, and read as one buyer's setting for how much
-- everyone ELSE gets. It belongs to the portfolio, which every member reads.
--
-- WHY NOT inside `thesis_policy`. That column is named and documented as the
-- SELL discipline, its owner panel is "Sell discipline", and its TS twin has a
-- fixed key set with an isDefault over it. A cash key there would be a naming
-- lie that also mis-reports the panel's "Customised" marker.
--
-- WHAT IT IS NOT. A reserve is a TRANSFER of budget from the screen draft to
-- the buyers that run before it — not a renewable supply. Only sells (and
-- deposits) create cash; on a book that rarely sells, raising the reserve funds
-- an occasional extra add rather than a continuous stream.
--
-- Behaviour-preserving: `cash_policy.resolve_policy()` fills every key from
-- DEFAULTS, whose reserve_pct is 2.0 — exactly the `snake_draft_plan` default
-- in force before this migration. `{}` (the column default) therefore changes
-- nothing for any existing portfolio, and the code works whether or not this
-- migration has been applied.
--
-- Idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. The column
-- ============================================================
ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS cash_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN portfolios.cash_policy IS
    'Owner-configured cash policy for the shared pot, read by the swarm draft. '
    'Keys: reserve_pct (number, percent of NAV, 0-50) — the screen draft stops '
    'buying at this cash level, leaving the difference for buyers that run '
    'before it (e.g. double_down) on the next heartbeat. Missing keys fall back '
    'to cash_policy.DEFAULTS (reserve_pct 2.0 = the pre-088 draft default); '
    '{} means "all defaults" and is behaviour-identical to pre-088.';

-- ============================================================
-- 2. Backfill: leave existing rows at '{}' so they pick up DEFAULTS.
--    Nothing to do — the column default covers existing and new rows, and
--    DEFAULTS reproduces the pre-088 behaviour exactly. Stated explicitly so
--    the intent is not mistaken for an omission.
-- ============================================================

-- ============================================================
-- 3. Verify
-- ============================================================
-- SELECT slug, display_name, cash_policy FROM portfolios ORDER BY created_at;
