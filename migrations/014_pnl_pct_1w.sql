-- Migration 014: add `pnl_pct_1w` to agent_leaderboard.
--
-- The leaderboard tab strip already exposes 1D / 30D / YTD / 1YR. A 1-week
-- window fills the gap between "today's noise" and "month-over-month" — it
-- sees one weekly rebalance cycle but still resets fast enough to surface
-- agents that just shifted strategy. Same NULL-on-insufficient-history
-- discipline as the other windows (migration 012): a 5-day-old agent's
-- "1w" cell stays NULL so the frontend renders "calculating".

DROP VIEW IF EXISTS agent_leaderboard;

CREATE VIEW agent_leaderboard AS
WITH latest AS (
    SELECT DISTINCT ON (agent_id)
        agent_id,
        snapshot_date,
        cash_usd,
        holdings_value_usd,
        total_value_usd,
        pnl_usd,
        pnl_pct,
        num_positions
    FROM agent_portfolio_history
    ORDER BY agent_id, snapshot_date DESC
),
one_day_ago AS (
    SELECT DISTINCT ON (agent_id)
        agent_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY agent_id, snapshot_date DESC
),
one_week_ago AS (
    SELECT DISTINCT ON (agent_id)
        agent_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY agent_id, snapshot_date DESC
),
thirty_days_ago AS (
    SELECT DISTINCT ON (agent_id)
        agent_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY agent_id, snapshot_date DESC
),
year_start AS (
    SELECT DISTINCT ON (agent_id)
        agent_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date < DATE_TRUNC('year', CURRENT_DATE)::DATE
    ORDER BY agent_id, snapshot_date DESC
),
one_year_ago AS (
    SELECT DISTINCT ON (agent_id)
        agent_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '1 year'
    ORDER BY agent_id, snapshot_date DESC
),
sharpe_returns AS (
    SELECT
        agent_id,
        (total_value_usd - LAG(total_value_usd) OVER w)
            / NULLIF(LAG(total_value_usd) OVER w, 0) AS daily_return
    FROM agent_portfolio_history
    WHERE EXTRACT(DOW FROM snapshot_date) BETWEEN 1 AND 5
    WINDOW w AS (PARTITION BY agent_id ORDER BY snapshot_date)
),
sharpe AS (
    SELECT
        agent_id,
        AVG(daily_return)         AS mean_return,
        STDDEV_SAMP(daily_return) AS stdev_return,
        COUNT(daily_return)       AS n_returns
    FROM sharpe_returns
    WHERE daily_return IS NOT NULL
    GROUP BY agent_id
)
SELECT
    a.handle,
    a.display_name,
    a.is_house_agent,
    l.snapshot_date,
    l.cash_usd,
    l.holdings_value_usd,
    l.total_value_usd,
    l.pnl_usd,
    l.pnl_pct,
    l.num_positions,
    CASE
        WHEN t1d.value_anchor IS NULL OR t1d.value_anchor = 0 THEN NULL
        ELSE ROUND(((l.total_value_usd - t1d.value_anchor)
                    / t1d.value_anchor) * 100, 4)
    END AS pnl_pct_1d,
    CASE
        WHEN t1w.value_anchor IS NULL OR t1w.value_anchor = 0 THEN NULL
        ELSE ROUND(((l.total_value_usd - t1w.value_anchor)
                    / t1w.value_anchor) * 100, 4)
    END AS pnl_pct_1w,
    CASE
        WHEN t30.value_anchor IS NULL OR t30.value_anchor = 0 THEN NULL
        ELSE ROUND(((l.total_value_usd - t30.value_anchor)
                    / t30.value_anchor) * 100, 4)
    END AS pnl_pct_30d,
    CASE
        WHEN tytd.value_anchor IS NULL OR tytd.value_anchor = 0 THEN NULL
        ELSE ROUND(((l.total_value_usd - tytd.value_anchor)
                    / tytd.value_anchor) * 100, 4)
    END AS pnl_pct_ytd,
    CASE
        WHEN t1y.value_anchor IS NULL OR t1y.value_anchor = 0 THEN NULL
        ELSE ROUND(((l.total_value_usd - t1y.value_anchor)
                    / t1y.value_anchor) * 100, 4)
    END AS pnl_pct_1yr,
    CASE
        WHEN s.n_returns < 30
          OR s.stdev_return IS NULL
          OR s.stdev_return = 0 THEN NULL
        ELSE ROUND((((s.mean_return - 0.05 / 252.0) / s.stdev_return) * SQRT(252))::numeric, 4)
    END AS sharpe,
    COALESCE(s.n_returns, 0)::int AS sharpe_n_returns
FROM latest l
JOIN agents a ON a.id = l.agent_id
LEFT JOIN one_day_ago     t1d  ON t1d.agent_id  = l.agent_id
LEFT JOIN one_week_ago    t1w  ON t1w.agent_id  = l.agent_id
LEFT JOIN thirty_days_ago t30  ON t30.agent_id  = l.agent_id
LEFT JOIN year_start      tytd ON tytd.agent_id = l.agent_id
LEFT JOIN one_year_ago    t1y  ON t1y.agent_id  = l.agent_id
LEFT JOIN sharpe          s    ON s.agent_id    = l.agent_id
ORDER BY l.pnl_pct DESC;
