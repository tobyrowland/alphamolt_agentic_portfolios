-- Migration 037: two portfolio types per user (paper arena + live personal)
--
-- A portfolio's TYPE is its `mode` (migration 036): 'paper' = the
-- public-capable arena portfolio; 'live' = a PRIVATE personal real-money
-- (Alpaca-backed) account. This migration lets a single human hold ONE of
-- each, and pins the rules that make a live portfolio a personal account
-- rather than an arena competitor — so the size/baseline/promotion frictions
-- of putting real money on the public leaderboard never arise.

-- ============================================================
-- 1. Uniqueness: one portfolio per (user, mode) instead of per user.
--    A human can now hold one paper + one live. Legacy agent rows
--    (owner_user_id NULL) stay unaffected — the index is partial.
-- ============================================================
DROP INDEX IF EXISTS idx_portfolios_one_per_user;
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_one_per_user_mode
    ON portfolios (owner_user_id, mode) WHERE owner_user_id IS NOT NULL;

-- ============================================================
-- 2. A live portfolio is always private. It never appears on the public
--    leaderboard or any public surface — it's the owner's personal account,
--    visible only to them. Legacy agent rows are mode='paper', so the
--    'paper' branch keeps them (rightly) able to be public.
-- ============================================================
ALTER TABLE portfolios DROP CONSTRAINT IF EXISTS chk_portfolios_live_private;
ALTER TABLE portfolios
    ADD CONSTRAINT chk_portfolios_live_private
    CHECK (mode = 'paper' OR is_public = FALSE);

-- ============================================================
-- 3. Exempt live portfolios from the public/private hysteresis (migration
--    031). The 15/10-equity gate polices the public arena; a private
--    personal account shouldn't be forced to hold 15 names or be flipped
--    public. Recreated with an explicit live guard: a live portfolio
--    attempting to go public is refused with a clear message (defence in
--    depth alongside the CHECK above). The floor trigger only acts on
--    is_public = TRUE rows, which a live portfolio can never be, so it is
--    already a no-op for them and needs no change.
-- ============================================================
CREATE OR REPLACE FUNCTION enforce_portfolio_public_threshold()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INT;
BEGIN
    IF NEW.is_public = TRUE
       AND (OLD.is_public IS DISTINCT FROM TRUE)
       AND NEW.owner_user_id IS NOT NULL THEN

        IF NEW.mode = 'live' THEN
            RAISE EXCEPTION
              'portfolio % is a live (personal) portfolio and cannot be public',
              NEW.id
              USING ERRCODE = 'check_violation';
        END IF;

        SELECT COUNT(*) INTO v_count
            FROM portfolio_holdings
            WHERE portfolio_id = NEW.id;

        IF v_count < 15 THEN
            RAISE EXCEPTION
              'portfolio % cannot be made public: holds % equities, needs >= 15',
              NEW.id, v_count
              USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
