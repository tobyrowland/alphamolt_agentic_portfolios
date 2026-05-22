-- Migration 031: Replace the "launch" concept with a Private/Public hysteresis gate.
--
-- Background. Today human portfolios go through a draft -> launched lifecycle:
-- the portfolio row is inserted with launched_at NULL, no portfolio_accounts row
-- exists, agents can't rebalance, the portfolio is invisible. The owner has to
-- explicitly "Go live" to seed the $1M paper cash and set launched_at. This is
-- confusing in practice -- the "launch" affordance lives in a different spot
-- on /account than where the user first hits it ("Run now" on an agent), with
-- two different labels ("Go live" CTA vs "Launch the portfolio first." error),
-- and the chicken-and-egg framing ("the portfolio has no equities yet, why
-- launch it?") doesn't match the user's mental model.
--
-- New model. Portfolios are always live and funded with $1M. The only state
-- that matters publicly is whether the portfolio is Private or Public. The
-- Public toggle is hysteresis-gated on equity count:
--
--   * To flip Private -> Public: portfolio must hold >= 15 distinct equities.
--   * If a Public portfolio drops below 10 equities, it auto-reverts to Private.
--     It stays locked at Private until it climbs back to >= 15.
--   * Performance is tracked only during the current consecutive run of
--     snapshots with num_positions >= 10. A drop below 10 invalidates the
--     prior period: when the portfolio climbs back, a brand-new qualifying
--     period begins with a fresh baseline.
--
-- All of this applies to human-owned portfolios only (owner_user_id IS NOT
-- NULL). Legacy 1:1 agent-owned portfolios keep today's "always public,
-- no gate" behaviour.
--
-- launched_at and launch_portfolio() stay on the schema for backward compat.
-- A later cleanup migration can drop them once every reader has migrated.
--
-- Additive & idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. Backfill portfolio_accounts for every draft human portfolio
-- ============================================================
-- Every human portfolio gets a $1M paper-cash account, anchored to the
-- portfolio's creation date so the since-inception math is honest.

INSERT INTO portfolio_accounts (portfolio_id, cash_usd, starting_cash, inception_date)
SELECT p.id, 1000000.00, 1000000.00, p.created_at::date
  FROM portfolios p
 WHERE p.owner_user_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM portfolio_accounts pa WHERE pa.portfolio_id = p.id
   );


-- ============================================================
-- 2. New human portfolios default to Private
-- ============================================================
-- Existing rows are not touched. Server-side code in createPortfolio also
-- passes is_public = false belt-and-braces.

ALTER TABLE portfolios ALTER COLUMN is_public SET DEFAULT FALSE;


-- ============================================================
-- 3. Trigger: block Private -> Public unless >= 15 equities
-- ============================================================
-- Fires only when is_public flips false -> true on a human portfolio.
-- No-op for agent-owned portfolios (owner_user_id NULL) and for true -> false
-- flips (the auto-revert path must succeed).

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

DROP TRIGGER IF EXISTS portfolios_public_threshold ON portfolios;
CREATE TRIGGER portfolios_public_threshold
    BEFORE UPDATE ON portfolios
    FOR EACH ROW
    EXECUTE FUNCTION enforce_portfolio_public_threshold();


-- ============================================================
-- 4. Trigger: auto-revert Public -> Private when equity count drops below 10
-- ============================================================
-- Fires AFTER INSERT or DELETE on portfolio_holdings. Recounts inside the
-- body so multi-row transactions resolve to the correct final count.
-- No-op for agent-owned portfolios.

CREATE OR REPLACE FUNCTION enforce_portfolio_public_floor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_portfolio_id  UUID;
    v_owner_user_id UUID;
    v_is_public     BOOLEAN;
    v_count         INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_portfolio_id := OLD.portfolio_id;
    ELSE
        v_portfolio_id := NEW.portfolio_id;
    END IF;

    SELECT owner_user_id, is_public
      INTO v_owner_user_id, v_is_public
      FROM portfolios
     WHERE id = v_portfolio_id;

    -- Agent-owned portfolio, or portfolio already private -> nothing to do.
    IF v_owner_user_id IS NULL OR v_is_public IS NOT TRUE THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT COUNT(*) INTO v_count
        FROM portfolio_holdings
        WHERE portfolio_id = v_portfolio_id;

    IF v_count < 10 THEN
        UPDATE portfolios
           SET is_public = FALSE,
               updated_at = NOW()
         WHERE id = v_portfolio_id;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS portfolio_holdings_public_floor ON portfolio_holdings;
CREATE TRIGGER portfolio_holdings_public_floor
    AFTER INSERT OR DELETE ON portfolio_holdings
    FOR EACH ROW
    EXECUTE FUNCTION enforce_portfolio_public_floor();


-- ============================================================
-- 5. RPC: create_portfolio_funded -- atomic creation + funding
-- ============================================================
-- Single-call atomic insert of the portfolios row + the $1M portfolio_accounts
-- row. Replaces the old two-step JS insert + launch_portfolio() flow. Sets
-- is_public = FALSE (the new default for human portfolios).
--
-- Returns the new portfolio's id + slug. Slug uniqueness is enforced by the
-- existing UNIQUE constraint; uniqueness against owner_user_id is enforced by
-- the partial unique index from migration 024.

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
    v_id UUID;
BEGIN
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


-- ============================================================
-- 6. Rebuild agent_leaderboard -- current-qualifying-period only
-- ============================================================
-- Drops the existing view from migration 025 and replaces it with one that
-- implements the "consecutive >= 10 equities" rule using an islands-and-gaps
-- pattern:
--
--   * For each snapshot, prior_breaks = running count of days where
--     num_positions < 10. Within a single qualifying island (a consecutive
--     run of >= 10 snapshots), prior_breaks is constant.
--   * The "current" qualifying island for each portfolio is the set of rows
--     whose prior_breaks matches the latest snapshot's prior_breaks AND
--     num_positions >= 10.
--   * Portfolios whose latest snapshot is non-qualifying (num_positions < 10)
--     are excluded from the view entirely -- they're invisible on the
--     leaderboard until they climb back to >= 10.
--   * pnl_pct is measured against the FIRST snapshot of the current island
--     (period_start_value) -- the prior period's gains/losses are discarded
--     by design.
--   * Sharpe + 1d/1w/30d/ytd/1yr anchors are drawn from within the current
--     island only.
--
-- Scoping: per the design, the qualifying-period rule applies ONLY to
-- human-owned portfolios (owner_user_id NOT NULL). Legacy agent-owned
-- portfolios show their full history unchanged regardless of equity count.
-- This is implemented by making the "is the day a break?" expression
-- (`num_positions < 10`) effectively false for agent-owned portfolios:
-- their prior_breaks stays 0 across history, so they always live in a
-- single qualifying island spanning all snapshots since inception, and
-- they never get hidden by the `qualifying_today` filter.

DROP VIEW IF EXISTS agent_leaderboard;

CREATE VIEW agent_leaderboard
    WITH (security_invoker = true)
AS
WITH portfolio_meta AS (
    -- One row per portfolio: is it a human-owned (gated) portfolio, or a
    -- legacy agent-owned (ungated) one?
    SELECT id AS portfolio_id, owner_user_id IS NOT NULL AS is_human
    FROM portfolios
),
classified AS (
    SELECT
        h.portfolio_id, h.snapshot_date, h.total_value_usd, h.num_positions,
        h.cash_usd, h.holdings_value_usd, h.pnl_usd,
        SUM(CASE WHEN pm.is_human AND h.num_positions < 10 THEN 1 ELSE 0 END)
            OVER (PARTITION BY h.portfolio_id ORDER BY h.snapshot_date
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
            AS prior_breaks
    FROM agent_portfolio_history h
    JOIN portfolio_meta pm ON pm.portfolio_id = h.portfolio_id
),
latest AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id, snapshot_date, total_value_usd, num_positions,
        cash_usd, holdings_value_usd, pnl_usd, prior_breaks
    FROM classified
    ORDER BY portfolio_id, snapshot_date DESC
),
qualifying_today AS (
    -- Agent portfolios always qualify (their is_human=false → the gate is
    -- irrelevant). Human portfolios only qualify when their latest snapshot
    -- holds >= 10 equities.
    SELECT l.*
      FROM latest l
      JOIN portfolio_meta pm ON pm.portfolio_id = l.portfolio_id
     WHERE NOT pm.is_human OR l.num_positions >= 10
),
period_rows AS (
    SELECT c.*
      FROM classified c
      JOIN qualifying_today qt
        ON c.portfolio_id = qt.portfolio_id
       AND c.prior_breaks = qt.prior_breaks
      JOIN portfolio_meta pm
        ON pm.portfolio_id = c.portfolio_id
     WHERE NOT pm.is_human OR c.num_positions >= 10
),
period_start AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id, snapshot_date AS period_started_at,
        total_value_usd AS period_start_value
    FROM period_rows
    ORDER BY portfolio_id, snapshot_date ASC
),
one_day_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
one_week_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
thirty_days_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
year_start AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date < DATE_TRUNC('year', CURRENT_DATE)::DATE
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
one_year_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '1 year'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
sharpe_returns AS (
    SELECT
        portfolio_id,
        (total_value_usd - LAG(total_value_usd) OVER w)
            / NULLIF(LAG(total_value_usd) OVER w, 0) AS daily_return
    FROM period_rows
    WHERE EXTRACT(DOW FROM snapshot_date) BETWEEN 1 AND 5
    WINDOW w AS (PARTITION BY portfolio_id ORDER BY snapshot_date)
),
sharpe AS (
    SELECT
        portfolio_id,
        AVG(daily_return)         AS mean_return,
        STDDEV_SAMP(daily_return) AS stdev_return,
        COUNT(daily_return)       AS n_returns
    FROM sharpe_returns
    WHERE daily_return IS NOT NULL
    GROUP BY portfolio_id
),
members AS (
    SELECT
        pa.portfolio_id,
        jsonb_agg(
            jsonb_build_object(
                'handle',         a.handle,
                'display_name',   a.display_name,
                'powered_by',     a.powered_by,
                'is_house_agent', a.is_house_agent
            )
            ORDER BY pa.joined_at
        ) AS member_agents
    FROM portfolio_agents pa
    JOIN agents a ON a.id = pa.agent_id
    GROUP BY pa.portfolio_id
)
SELECT
    p.slug                       AS handle,
    p.display_name,
    COALESCE(owner.is_house_agent, false) AS is_house_agent,
    l.snapshot_date,
    l.cash_usd,
    l.holdings_value_usd,
    l.total_value_usd,
    -- pnl_pct is measured against the start of the current qualifying period,
    -- not against starting_cash. Each new qualifying period starts fresh.
    ROUND(((l.total_value_usd - ps.period_start_value) / ps.period_start_value) * 100, 4)
        AS pnl_pct,
    -- pnl_usd is the dollar delta against the period's start value, mirroring
    -- pnl_pct. Useful for compact display alongside the percentage.
    ROUND((l.total_value_usd - ps.period_start_value), 4)
        AS pnl_usd,
    l.num_positions,
    CASE WHEN t1d.value_anchor IS NULL OR t1d.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t1d.value_anchor) / t1d.value_anchor) * 100, 4)
    END AS pnl_pct_1d,
    CASE WHEN t1w.value_anchor IS NULL OR t1w.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t1w.value_anchor) / t1w.value_anchor) * 100, 4)
    END AS pnl_pct_1w,
    CASE WHEN t30.value_anchor IS NULL OR t30.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t30.value_anchor) / t30.value_anchor) * 100, 4)
    END AS pnl_pct_30d,
    CASE WHEN tytd.value_anchor IS NULL OR tytd.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - tytd.value_anchor) / tytd.value_anchor) * 100, 4)
    END AS pnl_pct_ytd,
    CASE WHEN t1y.value_anchor IS NULL OR t1y.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t1y.value_anchor) / t1y.value_anchor) * 100, 4)
    END AS pnl_pct_1yr,
    CASE WHEN s.n_returns < 30 OR s.stdev_return IS NULL OR s.stdev_return = 0 THEN NULL
         ELSE ROUND((((s.mean_return - 0.05 / 252.0) / s.stdev_return) * SQRT(252))::numeric, 4)
    END AS sharpe,
    COALESCE(s.n_returns, 0)::int AS sharpe_n_returns,
    ps.period_started_at,
    p.id                          AS portfolio_id,
    p.slug                        AS portfolio_slug,
    p.display_name                AS portfolio_display_name,
    p.description                 AS portfolio_description,
    p.is_public                   AS is_public,
    p.launched_at                 AS launched_at,
    COALESCE(m.member_agents, '[]'::jsonb) AS member_agents
FROM latest l
JOIN qualifying_today qt ON qt.portfolio_id = l.portfolio_id
JOIN period_start  ps  ON ps.portfolio_id  = l.portfolio_id
JOIN portfolios    p   ON p.id             = l.portfolio_id
LEFT JOIN agents   owner ON owner.id       = p.owner_agent_id
LEFT JOIN one_day_ago     t1d  ON t1d.portfolio_id  = l.portfolio_id
LEFT JOIN one_week_ago    t1w  ON t1w.portfolio_id  = l.portfolio_id
LEFT JOIN thirty_days_ago t30  ON t30.portfolio_id  = l.portfolio_id
LEFT JOIN year_start      tytd ON tytd.portfolio_id = l.portfolio_id
LEFT JOIN one_year_ago    t1y  ON t1y.portfolio_id  = l.portfolio_id
LEFT JOIN sharpe          s    ON s.portfolio_id    = l.portfolio_id
LEFT JOIN members         m    ON m.portfolio_id    = l.portfolio_id
ORDER BY pnl_pct DESC NULLS LAST;
