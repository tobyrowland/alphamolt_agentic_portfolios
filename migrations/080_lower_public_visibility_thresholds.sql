-- Migration 080: lower the Public/Private visibility thresholds.
--
-- The Private -> Public hysteresis gate (migrations 031 + 037) previously
-- required a human portfolio to hold >= 15 distinct equities to flip Public,
-- and auto-reverted a Public portfolio to Private once it dropped below 10.
-- This migration lowers both:
--
--   * Flip Private -> Public: needs >= 12 equities (was 15).
--   * Auto-revert Public -> Private: drops below 8 equities (was 10).
--     A reverted portfolio stays locked Private until it climbs back to >= 12.
--   * Performance is tracked only during the current consecutive run of
--     snapshots with num_positions >= 8 (was >= 10) -- the agent_leaderboard
--     qualifying gate is kept coupled to the floor so a Public portfolio that
--     sits at 8-11 names both stays Public and stays on the leaderboard.
--
-- Human-owned portfolios only (owner_user_id NOT NULL); legacy agent rows are
-- unaffected by the triggers. Live (personal) portfolios stay always-private.
--
-- Idempotent. Paste-and-run in the Supabase SQL editor.

-- ============================================================
-- 1. Trigger: block Private -> Public unless >= 12 equities
--    (recreated from migration 037's deployed body, 15 -> 12; the live-mode
--     guard is preserved).
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

        IF v_count < 12 THEN
            RAISE EXCEPTION
              'portfolio % cannot be made public: holds % equities, needs >= 12',
              NEW.id, v_count
              USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- ============================================================
-- 2. Trigger: auto-revert Public -> Private when equity count drops below 8
--    (recreated from migration 031's deployed body, 10 -> 8).
-- ============================================================
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

    IF v_count < 8 THEN
        UPDATE portfolios
           SET is_public = FALSE,
               updated_at = NOW()
         WHERE id = v_portfolio_id;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- (Triggers portfolios_public_threshold / portfolio_holdings_public_floor
--  already point at these functions from migration 031 -- CREATE OR REPLACE
--  above is enough; no trigger re-wiring needed.)

-- ============================================================
-- 3. Rebuild agent_leaderboard -- qualifying gate 10 -> 8
--    Recreated from the CURRENTLY-DEPLOYED view body (which does not carry
--    migration 031's since-superseded human-only exemption); the only change
--    is the qualifying threshold num_positions >= 10 -> >= 8.
-- ============================================================
DROP VIEW IF EXISTS agent_leaderboard;

CREATE VIEW agent_leaderboard
    WITH (security_invoker = true)
AS
WITH classified AS (
    SELECT
        h.portfolio_id, h.snapshot_date, h.total_value_usd, h.num_positions,
        h.cash_usd, h.holdings_value_usd, h.pnl_usd,
        SUM(CASE WHEN h.num_positions < 8 THEN 1 ELSE 0 END)
            OVER (PARTITION BY h.portfolio_id ORDER BY h.snapshot_date
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
            AS prior_breaks
    FROM agent_portfolio_history h
),
latest AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id, snapshot_date, total_value_usd, num_positions,
        cash_usd, holdings_value_usd, pnl_usd, prior_breaks
    FROM classified
    ORDER BY portfolio_id, snapshot_date DESC
),
qualifying_today AS (
    SELECT l.*
      FROM latest l
     WHERE l.num_positions >= 8
),
period_rows AS (
    SELECT c.*
      FROM classified c
      JOIN qualifying_today qt
        ON c.portfolio_id = qt.portfolio_id
       AND c.prior_breaks = qt.prior_breaks
       AND c.num_positions >= 8
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
    ROUND(((l.total_value_usd - ps.period_start_value) / ps.period_start_value) * 100, 4)
        AS pnl_pct,
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
