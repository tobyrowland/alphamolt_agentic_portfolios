-- Migration 086: owner-configurable sell discipline (`portfolios.thesis_policy`).
--
-- WHY. When a buyer opens a position it also authors "break signals" — the
-- tripwires that will later justify selling it. The reviewer enforces them.
-- Nothing constrained what the buyer could write, and the owner — who holds
-- the actual sell discipline in their mandate prose — had no way to touch
-- them. Three failure modes followed, all observed in production on the
-- "Scrappy Fightback!" book (docs/case-studies/):
--
--   1. Born-broken theses. The portfolio's screen filters on
--      `perf_52w_vs_spy < -20`, so EVERY candidate underperforms by >20pp by
--      construction. The buyer then wrote `perf_52w_vs_spy < -20` as a BREAK
--      signal — true at the instant of purchase. FICO was bought and killed
--      six days later by a rule that could never have been false.
--
--   2. Extend signals read as breaks. ALLE and EXLS were sold while the
--      reviewer's own journal says "operational metrics remain healthy and
--      above the explicit break signals" — it sold on an unsatisfied EXTEND
--      signal (`perf_52w_vs_spy > 0`) instead. On a mandate that buys names
--      down >20pp, that condition needs a 20pp swing to be met.
--
--   3. No holding period. ALLE (86s), EXLS (85s) and NVO (80s) were bought
--      and sold inside a single heartbeat — the swarm runs buyers before
--      reviewers over the shared book, so a position opened seconds ago is
--      already in the reviewer's scope.
--
-- WHY PORTFOLIO-LEVEL, not an agent knob. Per-agent settings live in
-- `portfolio_agents.config` and reach exactly one member. But the buyer WRITES
-- break signals and the reviewer ACTS on them — a policy on either alone
-- cannot bind the other. So it belongs to the portfolio, which both read.
--
-- Enforcement per key lives in `thesis_policy.py` (pure, unit-tested):
--   grace_period_days           → portfolio_reviewer skips younger positions
--   require_fired_break_signal  → reviewer refuses a SELL when no break signal
--                                 is actually firing (and a thesis with
--                                 signals exists to check)
--   relative_fields_change_only → llm_watchlist_buyer drops price-relative
--                                 break/extend signals that use a STATIC
--                                 operator, keeping only the change-since-buy
--                                 form, which cannot be true on day one
--
-- Separately and unconditionally (not policy-gated — it is a correctness
-- invariant, no portfolio wants a position whose sell-trigger is already
-- tripped): `theses.record_thesis` now drops any break signal that already
-- evaluates true against the buy-time snapshot.
--
-- Behaviour-preserving for readers that predate it: `resolve_policy()` fills
-- every key from DEFAULTS, so `{}` (the column default) yields the new
-- defaults, and code works whether or not this migration has been applied.
--
-- Idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. The column
-- ============================================================
ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS thesis_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN portfolios.thesis_policy IS
    'Owner-configured sell discipline, read by BOTH the buyer (which authors '
    'break signals) and the reviewer (which enforces them). Keys: '
    'grace_period_days (int, 0 disables) — the reviewer ignores positions '
    'younger than this; require_fired_break_signal (bool) — a SELL needs an '
    'actually-firing break signal when the thesis has signals to check; '
    'relative_fields_change_only (bool) — price-relative fields '
    '(perf_52w_vs_spy, price_pct_of_52w_high, price, ps_now, composite_score) '
    'may only carry change-since-buy operators, never static thresholds. '
    'Missing keys fall back to thesis_policy.DEFAULTS; {} means "all defaults".';

-- ============================================================
-- 2. Backfill: leave existing rows at '{}' so they pick up DEFAULTS.
--    Nothing to do — the column default handles both existing and new rows.
--    Stated explicitly so the intent is not mistaken for an omission.
-- ============================================================

-- ============================================================
-- 3. Verify
-- ============================================================
-- SELECT slug, display_name, thesis_policy FROM portfolios ORDER BY created_at;
