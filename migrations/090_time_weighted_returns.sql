-- 090: measure return time-weighted, so a deposit stops looking like a loss.
--
-- WHY
-- ---
-- Every percentage this system reports is computed from raw portfolio VALUE,
-- which is only a return when no money moves in or out. That held while every
-- portfolio was a paper book funded once with $1M at creation. It stopped
-- holding when live sleeves arrived (migration 083), because a sleeve is
-- funded in tranches and can be topped up or drained at any time.
--
-- The Scrappy Fightback live sleeve on 2026-09-02 is the worked example. It
-- reported +0.80% against its paper twin's +6.28%, which reads as catastrophic
-- execution. It was arithmetic: the two books were measured over different
-- windows, and $29,600 of the sleeve's $39,600 baseline had arrived six days
-- earlier. Removing the flows gives +3.12% vs +3.74% — a real but ordinary
-- 0.6pp of cash drag and one bad marking day.
--
-- The same flaw sits in the interval columns and the Sharpe input, which are
-- plain value ratios: on 2026-08-27 the sleeve's `pnl_pct_1d` read as a ~43%
-- gain, because $12,149 was credited that morning. And `stdev` computed over
-- returns containing a 43% spike is not a risk measure of anything.
--
-- WHAT
-- ----
-- Two columns on `agent_portfolio_history`:
--   * `flow_usd`  — external cash IN (+) or OUT (-) that day. Written by
--                   portfolio_valuation.py from `portfolio_cash_ledger`.
--   * `twr_index` — cumulative time-weighted index, base 1.0 at a portfolio's
--                   first snapshot. Computed by `returns.py`, the pure module
--                   the daily writer and the backfill share.
--
-- and `agent_leaderboard` rebuilt to derive every RETURN from the index while
-- every DOLLAR figure still comes from value. That split is the point: "how
-- much money have I made" and "how good is this strategy" are different
-- questions, and only the first one is answerable from a cost basis.
--
-- WHY IT IS SAFE
-- --------------
-- A paper portfolio has no `portfolio_cash_ledger` rows at all — funded once
-- at creation, never again — so `flow_usd` is always 0 and the index is
-- mathematically identical to the value ratio it replaces. Not one number on
-- the public leaderboard moves. The change is visible only on live sleeves,
-- which is the only place it was ever wrong.
--
-- Every new expression COALESCEs to the old value-based one when `twr_index`
-- is NULL, so the view is correct between this migration and the backfill
-- (`backfill_twr.py`), and stays correct for any row the writer somehow
-- misses. For a flow-free portfolio the two branches agree exactly, so the
-- fallback is invisible rather than a second, disagreeing definition.
-- ============================================================

ALTER TABLE agent_portfolio_history
    ADD COLUMN IF NOT EXISTS flow_usd  NUMERIC(20,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS twr_index NUMERIC(20,10);

COMMENT ON COLUMN agent_portfolio_history.flow_usd IS
    'External capital in (+) / out (-) on this date, from portfolio_cash_ledger. '
    'Excludes baseline-reset rows, which correct a number rather than move money.';
COMMENT ON COLUMN agent_portfolio_history.twr_index IS
    'Cumulative time-weighted return index, 1.0 at the portfolio''s first '
    'snapshot. Return between any two dates is the ratio of their indices. '
    'Computed by returns.py; NULL until backfilled.';

-- ============================================================
-- agent_leaderboard — returns from the index, dollars from value.
-- Rebuilt from migration 080's body; every other line is unchanged.
-- ============================================================
DROP VIEW IF EXISTS agent_leaderboard;

CREATE VIEW agent_leaderboard
    WITH (security_invoker = true)
AS
WITH classified AS (
    SELECT
        h.portfolio_id, h.snapshot_date, h.total_value_usd, h.num_positions,
        h.cash_usd, h.holdings_value_usd, h.pnl_usd,
        h.flow_usd, h.twr_index,
        SUM(CASE WHEN h.num_positions < 8 THEN 1 ELSE 0 END)
            OVER (PARTITION BY h.portfolio_id ORDER BY h.snapshot_date
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
            AS prior_breaks
    FROM agent_portfolio_history h
),
latest AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id, snapshot_date, total_value_usd, num_positions,
        cash_usd, holdings_value_usd, pnl_usd, twr_index, prior_breaks
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
        total_value_usd AS period_start_value,
        twr_index       AS period_start_index
    FROM period_rows
    ORDER BY portfolio_id, snapshot_date ASC
),
-- Capital added or removed SINCE the period began. Subtracted from the dollar
-- P&L so a deposit is not reported as profit; the period's opening day is
-- excluded because period_start_value is already struck after its own flow.
period_flows AS (
    SELECT pr.portfolio_id, SUM(pr.flow_usd) AS net_flow
      FROM period_rows pr
      JOIN period_start ps ON ps.portfolio_id = pr.portfolio_id
     WHERE pr.snapshot_date > ps.period_started_at
     GROUP BY pr.portfolio_id
),
one_day_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor,
        pr.twr_index AS index_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
one_week_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor,
        pr.twr_index AS index_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
thirty_days_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor,
        pr.twr_index AS index_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
year_start AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor,
        pr.twr_index AS index_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date < DATE_TRUNC('year', CURRENT_DATE)::DATE
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
one_year_ago AS (
    SELECT DISTINCT ON (pr.portfolio_id)
        pr.portfolio_id, pr.total_value_usd AS value_anchor,
        pr.twr_index AS index_anchor
    FROM period_rows pr
    WHERE pr.snapshot_date <= CURRENT_DATE - INTERVAL '1 year'
    ORDER BY pr.portfolio_id, pr.snapshot_date DESC
),
-- Daily returns for Sharpe, from the index so a funding day is not counted as
-- a 43% move. Falls back to the value ratio only where the index is missing.
sharpe_returns AS (
    SELECT
        portfolio_id,
        CASE
            WHEN twr_index IS NOT NULL AND LAG(twr_index) OVER w > 0
                THEN twr_index / LAG(twr_index) OVER w - 1
            ELSE (total_value_usd - LAG(total_value_usd) OVER w)
                 / NULLIF(LAG(total_value_usd) OVER w, 0)
        END AS daily_return
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
    CASE WHEN l.twr_index IS NOT NULL AND ps.period_start_index > 0
         THEN ROUND(((l.twr_index / ps.period_start_index) - 1) * 100, 4)
         ELSE ROUND(((l.total_value_usd - ps.period_start_value)
                     / NULLIF(ps.period_start_value, 0)) * 100, 4)
    END AS pnl_pct,
    ROUND(l.total_value_usd - ps.period_start_value
          - COALESCE(pf.net_flow, 0), 4) AS pnl_usd,
    l.num_positions,
    CASE WHEN l.twr_index IS NOT NULL AND t1d.index_anchor > 0
         THEN ROUND(((l.twr_index / t1d.index_anchor) - 1) * 100, 4)
         WHEN t1d.value_anchor IS NULL OR t1d.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t1d.value_anchor) / t1d.value_anchor) * 100, 4)
    END AS pnl_pct_1d,
    CASE WHEN l.twr_index IS NOT NULL AND t1w.index_anchor > 0
         THEN ROUND(((l.twr_index / t1w.index_anchor) - 1) * 100, 4)
         WHEN t1w.value_anchor IS NULL OR t1w.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t1w.value_anchor) / t1w.value_anchor) * 100, 4)
    END AS pnl_pct_1w,
    CASE WHEN l.twr_index IS NOT NULL AND t30.index_anchor > 0
         THEN ROUND(((l.twr_index / t30.index_anchor) - 1) * 100, 4)
         WHEN t30.value_anchor IS NULL OR t30.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - t30.value_anchor) / t30.value_anchor) * 100, 4)
    END AS pnl_pct_30d,
    CASE WHEN l.twr_index IS NOT NULL AND tytd.index_anchor > 0
         THEN ROUND(((l.twr_index / tytd.index_anchor) - 1) * 100, 4)
         WHEN tytd.value_anchor IS NULL OR tytd.value_anchor = 0 THEN NULL
         ELSE ROUND(((l.total_value_usd - tytd.value_anchor) / tytd.value_anchor) * 100, 4)
    END AS pnl_pct_ytd,
    CASE WHEN l.twr_index IS NOT NULL AND t1y.index_anchor > 0
         THEN ROUND(((l.twr_index / t1y.index_anchor) - 1) * 100, 4)
         WHEN t1y.value_anchor IS NULL OR t1y.value_anchor = 0 THEN NULL
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
LEFT JOIN period_flows    pf   ON pf.portfolio_id   = l.portfolio_id
LEFT JOIN one_day_ago     t1d  ON t1d.portfolio_id  = l.portfolio_id
LEFT JOIN one_week_ago    t1w  ON t1w.portfolio_id  = l.portfolio_id
LEFT JOIN thirty_days_ago t30  ON t30.portfolio_id  = l.portfolio_id
LEFT JOIN year_start      tytd ON tytd.portfolio_id = l.portfolio_id
LEFT JOIN one_year_ago    t1y  ON t1y.portfolio_id  = l.portfolio_id
LEFT JOIN sharpe          s    ON s.portfolio_id    = l.portfolio_id
LEFT JOIN members         m    ON m.portfolio_id    = l.portfolio_id
ORDER BY pnl_pct DESC NULLS LAST;
