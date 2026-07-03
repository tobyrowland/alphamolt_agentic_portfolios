-- Migration 070: up to 5 paper portfolios per user; explicit live→paper link.
--
-- A human may now own up to FIVE mode='paper' (arena) portfolios — the point
-- is to let owners run several strategies head-to-head. The live follower
-- stays strictly one-per-user, and because "the owner's paper book" is no
-- longer unique, the live row now names the paper portfolio it mirrors via
-- follows_portfolio_id (replacing the implicit first-paper-sibling-by-owner
-- pairing in alpaca_mirror.py / agent_heartbeat.py).

-- ============================================================
-- 1. Uniqueness: only mode='live' stays one-per-user
-- ============================================================
-- The paper cap is enforced in create_portfolio_funded below (count-based,
-- easy to raise) rather than by an index.
DROP INDEX IF EXISTS idx_portfolios_one_per_user_mode;

CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolios_one_live_per_user
    ON portfolios (owner_user_id)
    WHERE owner_user_id IS NOT NULL AND mode = 'live';

-- Keep owner+mode lookups fast now that the unique index is gone.
CREATE INDEX IF NOT EXISTS idx_portfolios_owner_mode
    ON portfolios (owner_user_id, mode)
    WHERE owner_user_id IS NOT NULL;

-- ============================================================
-- 2. Explicit follower pairing
-- ============================================================
ALTER TABLE portfolios
    ADD COLUMN IF NOT EXISTS follows_portfolio_id UUID
        REFERENCES portfolios(id) ON DELETE SET NULL;

COMMENT ON COLUMN portfolios.follows_portfolio_id IS
    'For mode=''live'' rows: the paper portfolio this live follower mirrors. '
    'NULL on paper rows and on pre-070 live rows the backfill could not pair.';

-- Backfill: safe today because the pre-070 unique index guaranteed at most
-- one paper row per owner.
UPDATE portfolios l
   SET follows_portfolio_id = p.id
  FROM portfolios p
 WHERE l.mode = 'live'
   AND l.owner_user_id IS NOT NULL
   AND l.follows_portfolio_id IS NULL
   AND p.owner_user_id = l.owner_user_id
   AND p.mode = 'paper';

-- ============================================================
-- 3. create_portfolio_funded — same signature, now with the paper cap
-- ============================================================
CREATE OR REPLACE FUNCTION create_portfolio_funded(
    p_owner_user_id UUID,
    p_slug          TEXT,
    p_display_name  TEXT,
    p_description   TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id    UUID;
    v_count INT;
    -- The cap. Raise here and MAX_PAPER_PORTFOLIOS in
    -- web/lib/portfolios-query.ts together.
    c_max_paper CONSTANT INT := 5;
BEGIN
    -- Serialize concurrent creates per owner so two racing RPCs can't both
    -- pass the count check.
    PERFORM pg_advisory_xact_lock(hashtext(p_owner_user_id::text));

    SELECT COUNT(*) INTO v_count
      FROM portfolios
     WHERE owner_user_id = p_owner_user_id AND mode = 'paper';
    IF v_count >= c_max_paper THEN
        RAISE EXCEPTION
            'paper portfolio limit reached: you already have % of % portfolios',
            v_count, c_max_paper
            USING ERRCODE = 'check_violation';  -- 23514, matched by the web layer
    END IF;

    INSERT INTO portfolios (slug, display_name, description, owner_user_id,
                            owner_agent_id, is_public)
    VALUES (p_slug, p_display_name, p_description, p_owner_user_id,
            NULL, FALSE)
    RETURNING id INTO v_id;

    INSERT INTO portfolio_accounts (portfolio_id, cash_usd, starting_cash,
                                    inception_date)
    VALUES (v_id, 1000000.00, 1000000.00, CURRENT_DATE);

    RETURN jsonb_build_object('id', v_id, 'slug', p_slug);
END;
$$;

REVOKE ALL ON FUNCTION create_portfolio_funded FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_portfolio_funded TO service_role;
