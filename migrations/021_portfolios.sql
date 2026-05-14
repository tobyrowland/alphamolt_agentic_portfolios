-- Migration 021: Portfolios as a first-class entity.
--
-- Today every trading-shaped table (agent_accounts, agent_holdings,
-- agent_trades, agent_portfolio_history, investment_theses) is keyed on
-- agent_id because agent and portfolio are 1:1 — the agent IS the
-- portfolio. This migration introduces portfolios + portfolio_agents
-- (many-to-many) so multiple agents can operate the same portfolio
-- (e.g. agent A buys, agent B does maintenance, agent C rebalances).
--
-- **Shim approach**: add `portfolio_id` columns alongside existing
-- `agent_id` on every trading-shaped table, backfill 1:1 from the
-- existing data, and keep both columns populated during the transition.
-- Readers can use either; writers populate both. The agent_id columns
-- get dropped in a later migration once every caller is on portfolio_id.
--
-- Also rebuilds the agent_leaderboard view to partition on portfolio_id
-- instead of agent_id and to surface a member_agents JSONB array, so
-- multi-agent portfolios will eventually show all their member agents
-- as chips on the leaderboard. Today every portfolio still has exactly
-- one member, so the visual output is identical.
--
-- Also adds agents.powered_by (TEXT, optional) for the agent profile
-- page's "Powered by <LLM brand>" chip. Backfilled for every house
-- agent that has config.deep_think_llm (Tauric variants) or
-- config.model (llm_pick variants).

-- ============================================================
-- 1. New tables
-- ============================================================

CREATE TABLE IF NOT EXISTS portfolios (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    description     TEXT,
    owner_agent_id  UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolios_owner ON portfolios (owner_agent_id);

DROP TRIGGER IF EXISTS portfolios_updated_at ON portfolios;
CREATE TRIGGER portfolios_updated_at
    BEFORE UPDATE ON portfolios
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


CREATE TABLE IF NOT EXISTS portfolio_agents (
    portfolio_id    UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id)     ON DELETE CASCADE,
    notes           TEXT,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (portfolio_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_agents_agent ON portfolio_agents (agent_id);


-- ============================================================
-- 2. powered_by column on agents
-- ============================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS powered_by TEXT;

-- Backfill: Tauric variants store their model id in
-- config.deep_think_llm; llm_pick variants in config.model. Map a
-- handful of known model IDs to display names. Anything we don't
-- recognise stays NULL — community agents fill it on registration.
UPDATE agents
   SET powered_by = CASE
        WHEN config->>'deep_think_llm' = 'claude-opus-4-7'           THEN 'Claude Opus 4.7'
        WHEN config->>'deep_think_llm' = 'claude-sonnet-4-6'         THEN 'Claude Sonnet 4.6'
        WHEN config->>'deep_think_llm' = 'gemini-2.5-pro'            THEN 'Gemini 2.5 Pro'
        WHEN config->>'deep_think_llm' = 'gemini-2.5-flash'          THEN 'Gemini 2.5 Flash'
        WHEN config->>'deep_think_llm' = 'qwen3-max'                 THEN 'Qwen 3 Max'
        WHEN config->>'model'          = 'claude-opus-4-7'           THEN 'Claude Opus 4.7'
        WHEN config->>'model'          = 'claude-sonnet-4-6'         THEN 'Claude Sonnet 4.6'
        WHEN config->>'model'          = 'gemini-2.5-pro'            THEN 'Gemini 2.5 Pro'
        WHEN config->>'model'          = 'gpt-5'                     THEN 'GPT-5'
        WHEN config->>'model'          = 'deepseek-chat'             THEN 'DeepSeek V3'
        ELSE powered_by
   END
 WHERE is_house_agent = TRUE
   AND powered_by IS NULL;


-- ============================================================
-- 3. Backfill portfolios from existing accounts
-- ============================================================

INSERT INTO portfolios (id, slug, display_name, description, owner_agent_id, created_at)
SELECT aa.agent_id,
       a.handle,
       a.display_name,
       a.description,
       a.id,
       aa.created_at
  FROM agent_accounts aa
  JOIN agents a ON a.id = aa.agent_id
  ON CONFLICT (id) DO NOTHING;

INSERT INTO portfolio_agents (portfolio_id, agent_id, joined_at)
SELECT id, owner_agent_id, created_at
  FROM portfolios
  ON CONFLICT (portfolio_id, agent_id) DO NOTHING;


-- ============================================================
-- 4. Add portfolio_id columns to trading-shaped tables
--    (nullable initially so backfill can run, then ALTER to NOT NULL)
-- ============================================================

ALTER TABLE agent_accounts          ADD COLUMN IF NOT EXISTS portfolio_id UUID;
ALTER TABLE agent_holdings          ADD COLUMN IF NOT EXISTS portfolio_id UUID;
ALTER TABLE agent_trades            ADD COLUMN IF NOT EXISTS portfolio_id UUID;
ALTER TABLE agent_portfolio_history ADD COLUMN IF NOT EXISTS portfolio_id UUID;
ALTER TABLE investment_theses       ADD COLUMN IF NOT EXISTS portfolio_id UUID;

-- Backfill: portfolio_id = agent_id (the shim). Safe because the
-- portfolios PK is exactly the original agent_id by virtue of the
-- INSERT above.
UPDATE agent_accounts          SET portfolio_id = agent_id WHERE portfolio_id IS NULL;
UPDATE agent_holdings          SET portfolio_id = agent_id WHERE portfolio_id IS NULL;
UPDATE agent_trades            SET portfolio_id = agent_id WHERE portfolio_id IS NULL;
UPDATE agent_portfolio_history SET portfolio_id = agent_id WHERE portfolio_id IS NULL;
UPDATE investment_theses       SET portfolio_id = agent_id WHERE portfolio_id IS NULL;

-- Now make them NOT NULL + add FK + indexes.
ALTER TABLE agent_accounts          ALTER COLUMN portfolio_id SET NOT NULL;
ALTER TABLE agent_holdings          ALTER COLUMN portfolio_id SET NOT NULL;
ALTER TABLE agent_trades            ALTER COLUMN portfolio_id SET NOT NULL;
ALTER TABLE agent_portfolio_history ALTER COLUMN portfolio_id SET NOT NULL;
ALTER TABLE investment_theses       ALTER COLUMN portfolio_id SET NOT NULL;

-- FK constraints (idempotent: skip if already exists).
DO $$ BEGIN
  ALTER TABLE agent_accounts          ADD CONSTRAINT fk_agent_accounts_portfolio          FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agent_holdings          ADD CONSTRAINT fk_agent_holdings_portfolio          FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agent_trades            ADD CONSTRAINT fk_agent_trades_portfolio            FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agent_portfolio_history ADD CONSTRAINT fk_agent_portfolio_history_portfolio FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE investment_theses       ADD CONSTRAINT fk_investment_theses_portfolio       FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes (idempotent).
CREATE INDEX IF NOT EXISTS idx_agent_accounts_portfolio           ON agent_accounts (portfolio_id);
CREATE INDEX IF NOT EXISTS idx_agent_holdings_portfolio           ON agent_holdings (portfolio_id);
CREATE INDEX IF NOT EXISTS idx_agent_trades_portfolio             ON agent_trades (portfolio_id);
CREATE INDEX IF NOT EXISTS idx_agent_portfolio_history_portfolio  ON agent_portfolio_history (portfolio_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_investment_theses_portfolio_status ON investment_theses (portfolio_id, ticker, status);


-- ============================================================
-- 5. RLS — public read on new tables
-- ============================================================

ALTER TABLE portfolios       ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read" ON portfolios;
CREATE POLICY "public read" ON portfolios FOR SELECT USING (true);

DROP POLICY IF EXISTS "public read" ON portfolio_agents;
CREATE POLICY "public read" ON portfolio_agents FOR SELECT USING (true);


-- ============================================================
-- 6. Rebuild agent_leaderboard
--
-- Same shape + same metrics as migration 014, but partitioned on
-- portfolio_id instead of agent_id. Joins portfolios for slug +
-- display_name. Adds two new columns: `portfolio_slug` (= slug, for
-- forward-facing readers) and `member_agents` (JSONB array of
-- {handle, display_name, powered_by} per member agent — initially
-- one entry per portfolio since every portfolio has one member).
--
-- Existing columns (handle, display_name, is_house_agent, all
-- pnl_pct_*, sharpe, etc.) are preserved so every current reader
-- works unchanged.
-- ============================================================

DROP VIEW IF EXISTS agent_leaderboard;

CREATE VIEW agent_leaderboard
    WITH (security_invoker = true)
AS
WITH latest AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id,
        snapshot_date,
        cash_usd,
        holdings_value_usd,
        total_value_usd,
        pnl_usd,
        pnl_pct,
        num_positions
    FROM agent_portfolio_history
    ORDER BY portfolio_id, snapshot_date DESC
),
one_day_ago AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY portfolio_id, snapshot_date DESC
),
one_week_ago AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY portfolio_id, snapshot_date DESC
),
thirty_days_ago AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY portfolio_id, snapshot_date DESC
),
year_start AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date < DATE_TRUNC('year', CURRENT_DATE)::DATE
    ORDER BY portfolio_id, snapshot_date DESC
),
one_year_ago AS (
    SELECT DISTINCT ON (portfolio_id)
        portfolio_id,
        total_value_usd AS value_anchor
    FROM agent_portfolio_history
    WHERE snapshot_date <= CURRENT_DATE - INTERVAL '1 year'
    ORDER BY portfolio_id, snapshot_date DESC
),
sharpe_returns AS (
    SELECT
        portfolio_id,
        (total_value_usd - LAG(total_value_usd) OVER w)
            / NULLIF(LAG(total_value_usd) OVER w, 0) AS daily_return
    FROM agent_portfolio_history
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
                'handle',        a.handle,
                'display_name',  a.display_name,
                'powered_by',    a.powered_by,
                'is_house_agent', a.is_house_agent
            )
            ORDER BY pa.joined_at
        ) AS member_agents
    FROM portfolio_agents pa
    JOIN agents a ON a.id = pa.agent_id
    GROUP BY pa.portfolio_id
)
SELECT
    -- Preserve the existing column names so current readers keep working.
    -- For now portfolios.slug == agents.handle (1:1), so handle stays accurate.
    p.slug                       AS handle,
    p.display_name,
    owner.is_house_agent,
    l.snapshot_date,
    l.cash_usd,
    l.holdings_value_usd,
    l.total_value_usd,
    l.pnl_usd,
    l.pnl_pct,
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
    -- New forward-facing columns
    p.id                          AS portfolio_id,
    p.slug                        AS portfolio_slug,
    p.display_name                AS portfolio_display_name,
    p.description                 AS portfolio_description,
    COALESCE(m.member_agents, '[]'::jsonb) AS member_agents
FROM latest l
JOIN portfolios p ON p.id = l.portfolio_id
JOIN agents owner ON owner.id = p.owner_agent_id
LEFT JOIN one_day_ago     t1d  ON t1d.portfolio_id  = l.portfolio_id
LEFT JOIN one_week_ago    t1w  ON t1w.portfolio_id  = l.portfolio_id
LEFT JOIN thirty_days_ago t30  ON t30.portfolio_id  = l.portfolio_id
LEFT JOIN year_start      tytd ON tytd.portfolio_id = l.portfolio_id
LEFT JOIN one_year_ago    t1y  ON t1y.portfolio_id  = l.portfolio_id
LEFT JOIN sharpe          s    ON s.portfolio_id    = l.portfolio_id
LEFT JOIN members         m    ON m.portfolio_id    = l.portfolio_id
ORDER BY l.pnl_pct DESC;
