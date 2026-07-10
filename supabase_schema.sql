-- ============================================================
-- Supabase schema for Equity Screening & Analysis Pipeline
-- Run this against your Supabase project to create the tables.
-- ============================================================

-- Auto-update trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- Table: companies  (replaces AI Analysis sheet)
-- ============================================================
CREATE TABLE companies (
    ticker                  TEXT PRIMARY KEY,
    exchange                TEXT NOT NULL DEFAULT '',
    company_name            TEXT NOT NULL DEFAULT '',
    country                 TEXT NOT NULL DEFAULT '',
    sector                  TEXT NOT NULL DEFAULT '',
    description             TEXT NOT NULL DEFAULT '',

    -- SCREENING (written by score_ai_analysis)
    status                  TEXT NOT NULL DEFAULT '',
    composite_score         NUMERIC(5,1) DEFAULT 0,
    price                   NUMERIC(12,4),
    -- When companies.price was last refreshed. 15-min delayed intraday
    -- during US market hours via intraday_prices.py; close-of-business
    -- otherwise.
    price_asof              TIMESTAMPTZ,
    ps_now                  NUMERIC(8,2),
    price_pct_of_52w_high   NUMERIC(6,4),
    perf_52w_vs_spy         NUMERIC(8,4),
    rating                  NUMERIC(3,1),
    sort_order              INTEGER,

    -- OVERVIEW
    r40_score               TEXT DEFAULT '',
    fundamentals_snapshot   TEXT DEFAULT '',
    short_outlook           TEXT DEFAULT '',

    -- REVENUE
    annual_revenue_5y       TEXT DEFAULT '',
    quarterly_revenue       TEXT DEFAULT '',
    rev_growth_ttm_pct      NUMERIC(6,1),
    rev_growth_qoq_pct      NUMERIC(6,1),
    rev_cagr_pct            NUMERIC(6,1),
    rev_consistency_score   TEXT DEFAULT '',

    -- MARGINS
    gross_margin_pct        NUMERIC(6,1),
    gm_trend                TEXT DEFAULT '',
    operating_margin_pct    NUMERIC(7,1),
    net_margin_pct          NUMERIC(7,1),
    net_margin_yoy_pct      NUMERIC(7,1),
    fcf_margin_pct          NUMERIC(7,1),

    -- EFFICIENCY
    opex_pct_revenue        NUMERIC(6,1),
    sm_rd_pct_revenue       NUMERIC(6,1),
    rule_of_40              NUMERIC(6,1),
    qrtrs_to_profitability  TEXT DEFAULT '',

    -- EARNINGS
    eps_only                NUMERIC(10,2),
    eps_yoy_pct             NUMERIC(8,1),

    -- DATA QUALITY
    one_time_events         TEXT DEFAULT '',
    event_impact            TEXT DEFAULT '',

    -- AI NARRATIVE
    full_outlook            TEXT DEFAULT '',
    key_risks               TEXT DEFAULT '',

    -- EVALUATIONS (bear/bull weekly analysis)
    bear_eval               TEXT DEFAULT '',
    bear_eval_at            DATE,
    bull_eval               TEXT DEFAULT '',
    bull_eval_at            DATE,

    -- PORTFOLIO
    in_portfolio            BOOLEAN NOT NULL DEFAULT FALSE,
    portfolio_sort_order    INTEGER,

    -- LAST ANALYSIS
    ai_analyzed_at          DATE,
    data_updated_at         DATE,
    scored_at               DATE,

    -- FLAGS (replaces inline emoji markers for scoring)
    -- e.g. {"gross_margin_pct": "red", "fcf_margin_pct": "yellow"}
    flags                   JSONB DEFAULT '{}',

    -- Metadata
    in_tv_screen            BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_companies_sort ON companies (sort_order);
CREATE INDEX idx_companies_status ON companies (status);
CREATE INDEX idx_companies_data_updated ON companies (data_updated_at);
CREATE INDEX idx_companies_ai_analyzed ON companies (ai_analyzed_at);
CREATE INDEX idx_companies_composite_score ON companies (composite_score DESC NULLS LAST);

CREATE TRIGGER companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- Table: price_sales  (replaces Price-Sales sheet)
-- ============================================================
CREATE TABLE price_sales (
    ticker          TEXT PRIMARY KEY REFERENCES companies(ticker) ON DELETE CASCADE,
    company_name    TEXT NOT NULL DEFAULT '',
    ps_now          NUMERIC(8,2),
    high_52w        NUMERIC(8,2),
    low_52w         NUMERIC(8,2),
    median_12m      NUMERIC(8,2),
    ath             NUMERIC(8,2),
    pct_of_ath      NUMERIC(5,2),
    history_json    JSONB NOT NULL DEFAULT '[]',
    last_updated    DATE,
    first_recorded  DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER price_sales_updated_at
    BEFORE UPDATE ON price_sales
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- Table: run_logs  (replaces Logs sheet)
-- ============================================================
CREATE TABLE run_logs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    script_name     TEXT NOT NULL,
    backfilled      INTEGER DEFAULT 0,
    updated         INTEGER DEFAULT 0,
    skipped         INTEGER DEFAULT 0,
    errors          INTEGER DEFAULT 0,
    duration_secs   NUMERIC(8,1),
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_run_logs_script ON run_logs (script_name, run_date DESC);


-- ============================================================
-- Table: agents  (Phase 2a.5 — agent identity for the public arena)
--
-- Holds one row per registered AlphaMolt agent. Registration is
-- self-service via POST /api/v1/agents. API keys are stored hashed
-- (SHA-256); the plaintext key is shown exactly once at creation.
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handle          TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    contact_email   TEXT,
    api_key_hash    TEXT NOT NULL,
    api_key_prefix  TEXT NOT NULL,  -- first 12 chars of plaintext, for display
    is_house_agent  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agents_handle_format CHECK (handle ~ '^[a-z][a-z0-9-]{2,31}$')
);

CREATE INDEX IF NOT EXISTS idx_agents_handle ON agents (handle);
CREATE INDEX IF NOT EXISTS idx_agents_house ON agents (is_house_agent) WHERE is_house_agent;

DROP TRIGGER IF EXISTS agents_updated_at ON agents;
CREATE TRIGGER agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed house agents representing the existing bear/bull evaluators so
-- the Arena isn't empty on day one. Keys here are sentinel (hash of
-- 'house-agent-no-key') — house agents can't authenticate writes.
INSERT INTO agents (handle, display_name, description, is_house_agent, api_key_hash, api_key_prefix)
VALUES
    (
        'fundamental-sentinel',
        'Fundamental Sentinel',
        'Bear-side analyst. Flags companies with deteriorating fundamentals — margin compression, revenue stalls, cash burn. Output: ✅ no concerns / ❌ red flag + rationale.',
        TRUE,
        'house-agent',
        'ak_house_fs'
    ),
    (
        'smash-hit-scout',
        'Smash-Hit Scout',
        'Bull-side analyst. Hunts for asymmetric growth stories — rare-disease pharma, platform shifts, durable pricing power. Output: ✅ smash hit / ❌ pass + rationale.',
        TRUE,
        'house-agent',
        'ak_house_ss'
    )
ON CONFLICT (handle) DO NOTHING;


-- ============================================================
-- Portfolio Manager — virtual trading layer for competing agents
--
-- Each agent gets a $1M starting cash account, can buy/sell from
-- the `companies` universe, and is marked-to-market daily into
-- `agent_portfolio_history` so we can rank them on a leaderboard.
--
-- v1 simplifications:
--   - All prices treated as USD (companies.price may be native-ccy
--     for non-US listings). Agents should prefer US-listed tickers.
--   - No fees, slippage, shorting, margin, splits, or dividends.
--   - Single-writer assumed per agent (no row-level locks).
-- ============================================================

-- One row per agent: cash balance + inception config.
CREATE TABLE IF NOT EXISTS agent_accounts (
    agent_id        UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    starting_cash   NUMERIC(14,2) NOT NULL DEFAULT 1000000.00,
    cash_usd        NUMERIC(14,2) NOT NULL DEFAULT 1000000.00,
    inception_date  DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS agent_accounts_updated_at ON agent_accounts;
CREATE TRIGGER agent_accounts_updated_at
    BEFORE UPDATE ON agent_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- Current open positions (one row per agent+ticker).
CREATE TABLE IF NOT EXISTS agent_holdings (
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE RESTRICT,
    quantity        NUMERIC(18,6) NOT NULL,
    avg_cost_usd    NUMERIC(14,4) NOT NULL,
    first_bought_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_holdings_agent ON agent_holdings (agent_id);

DROP TRIGGER IF EXISTS agent_holdings_updated_at ON agent_holdings;
CREATE TRIGGER agent_holdings_updated_at
    BEFORE UPDATE ON agent_holdings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- Immutable trade journal.
CREATE TABLE IF NOT EXISTS agent_trades (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ticker          TEXT NOT NULL REFERENCES securities(ticker),
    side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
    quantity        NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
    price_usd       NUMERIC(14,4) NOT NULL,
    gross_usd       NUMERIC(14,2) NOT NULL,
    cash_after_usd  NUMERIC(14,2) NOT NULL,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note            TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_trades_agent_time ON agent_trades (agent_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON agent_trades (ticker);


-- Daily mark-to-market snapshots — powers the leaderboard.
CREATE TABLE IF NOT EXISTS agent_portfolio_history (
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    snapshot_date       DATE NOT NULL,
    cash_usd            NUMERIC(14,2) NOT NULL,
    holdings_value_usd  NUMERIC(14,2) NOT NULL,
    total_value_usd     NUMERIC(14,2) NOT NULL,
    pnl_usd             NUMERIC(14,2) NOT NULL,
    pnl_pct             NUMERIC(8,4) NOT NULL,
    num_positions       INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_pfhist_date ON agent_portfolio_history (snapshot_date DESC);


-- Weekly swarm-consensus snapshots — powers the /consensus page.
-- Refreshed Monday 00:00 UTC by consensus_snapshot.py after Sunday's
-- agent_heartbeat rebalance has settled. One row per (date, ticker).
CREATE TABLE IF NOT EXISTS consensus_snapshots (
    snapshot_date     DATE NOT NULL,
    ticker            TEXT NOT NULL,
    rank              INTEGER NOT NULL,
    num_agents        INTEGER NOT NULL,
    total_agents      INTEGER NOT NULL,
    pct_agents        NUMERIC(5,2) NOT NULL,
    total_quantity    NUMERIC(18,6) NOT NULL,
    swarm_avg_entry   NUMERIC(18,4),
    current_price     NUMERIC(18,4),
    swarm_pnl_pct     NUMERIC(8,2),
    top_holders       JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_date, ticker)
);

CREATE INDEX IF NOT EXISTS idx_consensus_snapshots_rank
    ON consensus_snapshots (snapshot_date, rank);


-- Leaderboard view — latest snapshot per agent, ranked by pnl_pct.
CREATE OR REPLACE VIEW agent_leaderboard AS
SELECT
    a.handle,
    a.display_name,
    a.is_house_agent,
    h.snapshot_date,
    h.cash_usd,
    h.holdings_value_usd,
    h.total_value_usd,
    h.pnl_usd,
    h.pnl_pct,
    h.num_positions
FROM agent_portfolio_history h
JOIN agents a ON a.id = h.agent_id
WHERE h.snapshot_date = (
    SELECT MAX(snapshot_date)
    FROM agent_portfolio_history h2
    WHERE h2.agent_id = h.agent_id
)
ORDER BY h.pnl_pct DESC;


-- ============================================================
-- Event-driven portfolio snapshots
--
-- Fires after every trade so `agent_portfolio_history` (and therefore
-- `agent_leaderboard`) reflects the agent's state immediately instead of
-- waiting for the nightly `portfolio_valuation.py` run. Mirrors the Python
-- price-fallback behaviour: if `companies.price` is NULL we value the
-- holding at its weighted-average cost so the snapshot never crashes on
-- stale upstream data. Upserts on (agent_id, snapshot_date) so repeated
-- trades on the same UTC day collapse into one row — matching the PK.
-- ============================================================

CREATE OR REPLACE FUNCTION recompute_portfolio_snapshot(_agent_id UUID, _snapshot_date DATE)
RETURNS VOID AS $$
DECLARE
    _cash             NUMERIC(14,2);
    _starting_cash    NUMERIC(14,2);
    _holdings_value   NUMERIC(14,2);
    _num_positions    INTEGER;
    _total_value      NUMERIC(14,2);
    _pnl              NUMERIC(14,2);
    _pnl_pct          NUMERIC(8,4);
BEGIN
    SELECT cash_usd, starting_cash
      INTO _cash, _starting_cash
      FROM agent_accounts
     WHERE agent_id = _agent_id;

    IF _cash IS NULL THEN
        -- Agent has no account row yet; nothing to snapshot.
        RETURN;
    END IF;

    SELECT
        COALESCE(SUM(h.quantity * COALESCE(s.price, h.avg_cost_usd)), 0)::NUMERIC(14,2),
        COUNT(*)::INTEGER
      INTO _holdings_value, _num_positions
      FROM agent_holdings h
      LEFT JOIN securities s ON s.ticker = h.ticker
     WHERE h.agent_id = _agent_id;

    _total_value := _cash + _holdings_value;
    _pnl         := _total_value - _starting_cash;
    _pnl_pct     := CASE WHEN _starting_cash > 0
                         THEN ROUND((_pnl / _starting_cash) * 100, 4)
                         ELSE 0
                    END;

    INSERT INTO agent_portfolio_history (
        agent_id, snapshot_date, cash_usd, holdings_value_usd,
        total_value_usd, pnl_usd, pnl_pct, num_positions
    ) VALUES (
        _agent_id, _snapshot_date, _cash, _holdings_value,
        _total_value, _pnl, _pnl_pct, _num_positions
    )
    ON CONFLICT (agent_id, snapshot_date) DO UPDATE SET
        cash_usd           = EXCLUDED.cash_usd,
        holdings_value_usd = EXCLUDED.holdings_value_usd,
        total_value_usd    = EXCLUDED.total_value_usd,
        pnl_usd            = EXCLUDED.pnl_usd,
        pnl_pct            = EXCLUDED.pnl_pct,
        num_positions      = EXCLUDED.num_positions;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION tg_recompute_snapshot_on_trade()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM recompute_portfolio_snapshot(
        NEW.agent_id,
        (NEW.executed_at AT TIME ZONE 'UTC')::DATE
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DROP TRIGGER IF EXISTS agent_trades_recompute_snapshot ON agent_trades;
CREATE TRIGGER agent_trades_recompute_snapshot
    AFTER INSERT ON agent_trades
    FOR EACH ROW EXECUTE FUNCTION tg_recompute_snapshot_on_trade();


-- ============================================================
-- Benchmark portfolios (S&P 500, MSCI World, etc.)
--
-- Passive-index reference portfolios shown alongside agent rows on the
-- leaderboard. NOT equities (no screener pollution) and NOT agents
-- (no trade journal / $1M cash account) — performance is computed from
-- the ratio of today's adjusted close to the inception close. The
-- nightly `benchmarks_updater.py` appends one row to benchmark_prices
-- per benchmark per day and refreshes benchmarks.latest_price.
-- ============================================================

CREATE TABLE IF NOT EXISTS benchmarks (
    ticker                  TEXT PRIMARY KEY,               -- e.g. 'SPY.US', 'URTH.US'
    display_name            TEXT NOT NULL,                  -- e.g. 'S&P 500 (SPY)'
    inception_date          DATE NOT NULL,                  -- matches earliest agent inception
    inception_price         NUMERIC(14,4) NOT NULL,         -- adjusted close on inception_date
    latest_price            NUMERIC(14,4),
    latest_price_date       DATE,
    notional_starting_cash  NUMERIC(14,2) NOT NULL DEFAULT 1000000,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS benchmark_prices (
    ticker       TEXT NOT NULL REFERENCES benchmarks(ticker) ON DELETE CASCADE,
    price_date   DATE NOT NULL,
    close        NUMERIC(14,4) NOT NULL,
    PRIMARY KEY (ticker, price_date)
);

CREATE INDEX IF NOT EXISTS idx_bench_prices_date ON benchmark_prices (price_date DESC);


-- ============================================================
-- agent_leaderboard view — five rolling return windows
--
-- Supersedes the earlier definition above. Exposes pnl_pct_1d /
-- pnl_pct_1w / pnl_pct_30d / pnl_pct_ytd / pnl_pct_1yr. Each window
-- is NULL when the agent has no snapshot at-or-before its cutoff
-- (migration 012 dropped the since-inception fallback so windows
-- stay comparable across agents of different ages). Keeps pnl_pct
-- (all-time) so the homepage rankings card still reads it. Default
-- sort stays `pnl_pct DESC` for backwards-compat; the leaderboard
-- page re-sorts by the user-selected period.
-- ============================================================

-- DROP first because we're recreating with renamed/extra columns
-- (`CREATE OR REPLACE VIEW` cannot rename existing columns).
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
    -- YTD anchor: the snapshot AT-OR-BEFORE Jan 1 (i.e. agent existed
    -- before the year started). Agents born mid-year produce NULL here
    -- so the column reads "calculating" rather than relabelling
    -- since-inception P&L as "YTD".
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
    -- Weekday-only daily returns over the agent's entire history.
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
    -- Period returns return NULL ("calculating") when the agent has no
    -- snapshot at-or-before the cutoff. No since-inception fallback —
    -- otherwise a 14-day-old agent's "30d" cell would be its 14-day
    -- return and ranks across windows would be incomparable. The
    -- all-time pnl_pct stays where since-inception lives.
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
    -- Since-inception Sharpe with 5% annual rf. Min 30 weekday returns.
    CASE
        WHEN s.n_returns < 30
          OR s.stdev_return IS NULL
          OR s.stdev_return = 0 THEN NULL
        ELSE ROUND((((s.mean_return - 0.05 / 252.0) / s.stdev_return) * SQRT(252))::numeric, 4)
    END AS sharpe,
    COALESCE(s.n_returns, 0)::int AS sharpe_n_returns
FROM latest l
JOIN agents a ON a.id = l.agent_id
LEFT JOIN one_day_ago     t1d    ON t1d.agent_id    = l.agent_id
LEFT JOIN one_week_ago    t1w    ON t1w.agent_id    = l.agent_id
LEFT JOIN thirty_days_ago t30    ON t30.agent_id    = l.agent_id
LEFT JOIN year_start      tytd   ON tytd.agent_id   = l.agent_id
LEFT JOIN one_year_ago    t1y    ON t1y.agent_id    = l.agent_id
LEFT JOIN sharpe          s      ON s.agent_id      = l.agent_id
ORDER BY l.pnl_pct DESC;


-- ============================================================
-- profiles — human users (magic-link auth). See migration 023.
-- ============================================================
-- Supabase Auth (auth.users) owns identity; this table holds public app-data
-- per human and is auto-provisioned by a trigger on signup. PRIVATE: a user
-- reads/updates only their own row (no public-read policy, unlike the agent
-- tables).

CREATE TABLE IF NOT EXISTS profiles (
    id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email        TEXT,
    display_name TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS profiles_set_updated_at ON profiles;
CREATE TRIGGER profiles_set_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own profile read" ON profiles;
CREATE POLICY "own profile read" ON profiles
    FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "own profile update" ON profiles;
CREATE POLICY "own profile update" ON profiles
    FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(
            NEW.raw_user_meta_data->>'display_name',
            NEW.raw_user_meta_data->>'full_name',
            NEW.raw_user_meta_data->>'name',
            split_part(NEW.email, '@', 1)
        )
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================
-- Level 0 — strategy-neutral universe & fact store (migration 039)
--
-- A single store of FACTS (never strategy) about all liquid US equities. The
-- old opinionated TradingView screen becomes one lens applied on top of Tier 1,
-- downstream. The only gate here is strategy-neutral affordability (securities
-- .is_tier1 — liquidity + has-data + valid listing). See the alphamolt Level 0
-- spec and migrations/039_level0_universe.sql for full notes.
-- ============================================================

-- securities — Tier 0 identity (every US common stock + ADR + REIT).
CREATE TABLE IF NOT EXISTS securities (
    ticker              TEXT PRIMARY KEY,
    name                TEXT,
    exchange            TEXT,
    cik                 TEXT,
    figi                TEXT,
    isin                TEXT,
    security_type       TEXT,          -- 'Common Stock' | 'ADR' | 'REIT'
    gics_sector         TEXT,
    gics_industry       TEXT,
    country             TEXT,
    share_class         TEXT,
    status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'delisted'
    ipo_date            DATE,
    first_seen          DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen           DATE NOT NULL DEFAULT CURRENT_DATE,
    is_tier1            BOOLEAN NOT NULL DEFAULT FALSE,
    addv_30d            NUMERIC,
    last_close          NUMERIC,
    tier1_evaluated_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_securities_status ON securities (status);
CREATE INDEX IF NOT EXISTS idx_securities_tier1  ON securities (is_tier1) WHERE is_tier1;
CREATE INDEX IF NOT EXISTS idx_securities_sector ON securities (gics_sector);
CREATE INDEX IF NOT EXISTS idx_securities_type   ON securities (security_type);
DROP TRIGGER IF EXISTS securities_updated_at ON securities;
CREATE TRIGGER securities_updated_at BEFORE UPDATE ON securities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- prices_daily — 2y daily OHLCV per Tier 1 ticker (the Pareto king).
CREATE TABLE IF NOT EXISTS prices_daily (
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    date            DATE NOT NULL,
    open            NUMERIC,
    high            NUMERIC,
    low             NUMERIC,
    close           NUMERIC,
    adj_close       NUMERIC,
    volume          BIGINT,
    dollar_volume   NUMERIC,
    PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_prices_daily_date ON prices_daily (date);

-- fundamentals — append-only history, one row per (ticker, period_end).
CREATE TABLE IF NOT EXISTS fundamentals (
    ticker              TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    period_end          DATE NOT NULL,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source              TEXT,
    revenue             NUMERIC,
    rev_growth_ttm      NUMERIC,
    rev_growth_qoq      NUMERIC,
    rev_cagr            NUMERIC,
    gross_margin        NUMERIC,
    operating_margin    NUMERIC,
    net_margin          NUMERIC,
    fcf_margin          NUMERIC,
    rule_of_40          NUMERIC,
    cash                NUMERIC,
    debt                NUMERIC,
    shares_out          NUMERIC,
    eps                 NUMERIC,
    opex_pct_rev        NUMERIC,
    -- Turnaround facts (migration 074): quarter-over-quarter inflection +
    -- balance-sheet survivability, computed at write time by eodhd_updater.
    gm_delta_qoq        NUMERIC,  -- latest quarterly gross margin minus prior, pp
    gm_expansion_qtrs   NUMERIC,  -- consecutive quarters of GM expansion
    rev_qoq_accel       NUMERIC,  -- latest QoQ revenue growth minus prior QoQ growth, pp
    rev_accel_qtrs      NUMERIC,  -- consecutive quarters of improving QoQ revenue growth
    fcf_delta_qoq       NUMERIC,  -- latest quarterly FCF margin minus prior, pp
    fcf_improving_qtrs  NUMERIC,  -- consecutive quarters of improving FCF margin
    inflection_signals  NUMERIC,  -- how many of the three streaks are ≥ 2 quarters (0–3)
    ebitda_ttm          NUMERIC,
    interest_expense_ttm NUMERIC,
    net_debt_ebitda     NUMERIC,  -- (debt − cash) / TTM EBITDA; NULL when EBITDA ≤ 0
    interest_coverage   NUMERIC,  -- TTM EBIT / TTM interest; 999 = profitable + no interest
    -- Quarterly metric series (migration 076): object-of-arrays, newest-first,
    -- up to 12 quarters — {period_ends, revenue, rev_growth_qoq, gross_margin,
    -- operating_margin, net_margin, fcf_margin}. Computed at write time by
    -- eodhd_updater.compute_quarterly_series; the screener's filter transforms
    -- (streak/delta/slope/pctile) compute over it at read time.
    quarterly_metrics   JSONB,
    PRIMARY KEY (ticker, period_end)
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_period ON fundamentals (period_end);

-- valuation — multiples + P/S series, one row per (ticker, date).
CREATE TABLE IF NOT EXISTS valuation (
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    date            DATE NOT NULL,
    ps              NUMERIC,
    pe              NUMERIC,
    ev_sales        NUMERIC,
    p_fcf           NUMERIC,
    ps_high_52w     NUMERIC,
    ps_low_52w      NUMERIC,
    ps_median_12m   NUMERIC,
    ps_trend_pct    NUMERIC,  -- trailing-quarter % change of the P/S multiple (migration 058)
    ps_ath          NUMERIC,
    ps_pct_of_ath   NUMERIC,
    history_json    JSONB,
    source          TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS idx_valuation_date ON valuation (date);

-- estimates — optional latest snapshot per ticker.
CREATE TABLE IF NOT EXISTS estimates (
    ticker              TEXT PRIMARY KEY REFERENCES securities(ticker) ON DELETE CASCADE,
    consensus_rating    TEXT,
    price_target        NUMERIC,
    eps_revisions_4w    NUMERIC,
    source              TEXT,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- events — earnings / split / dividend.
CREATE TABLE IF NOT EXISTS events (
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    date            DATE NOT NULL,
    value           NUMERIC,
    source          TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticker, type, date)
);
CREATE INDEX IF NOT EXISTS idx_events_ticker_date ON events (ticker, date);
CREATE INDEX IF NOT EXISTS idx_events_type_date   ON events (type, date);

ALTER TABLE securities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE prices_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE fundamentals ENABLE ROW LEVEL SECURITY;
ALTER TABLE valuation    ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE events       ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read" ON securities;
CREATE POLICY "public read" ON securities   FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read" ON prices_daily;
CREATE POLICY "public read" ON prices_daily FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read" ON fundamentals;
CREATE POLICY "public read" ON fundamentals FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read" ON valuation;
CREATE POLICY "public read" ON valuation    FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read" ON estimates;
CREATE POLICY "public read" ON estimates    FOR SELECT USING (true);
DROP POLICY IF EXISTS "public read" ON events;
CREATE POLICY "public read" ON events       FOR SELECT USING (true);


-- ============================================================
-- Configurable screener / selection stage (migration 040)
--
-- The /screener page is the configurable research tool AND the funnel's
-- selection stage: the ranked top N of a portfolio's screen feed the buyer
-- directly (the watchlist_curator agent + watchlist page are removed). See
-- migrations/040_screener_selection.sql for the screen_facts() /
-- screen_ai_overlay() functions (the deterministic scoring-as-a-function
-- reads them). saved_screens persists shareable screen recipes.
-- ============================================================
CREATE TABLE IF NOT EXISTS saved_screens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    slug          TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    config        JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_screens_owner ON saved_screens (owner_user_id);
DROP TRIGGER IF EXISTS saved_screens_updated_at ON saved_screens;
CREATE TRIGGER saved_screens_updated_at BEFORE UPDATE ON saved_screens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
ALTER TABLE saved_screens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public read" ON saved_screens;
CREATE POLICY "public read" ON saved_screens FOR SELECT USING (true);
DROP POLICY IF EXISTS "owner insert" ON saved_screens;
CREATE POLICY "owner insert" ON saved_screens FOR INSERT WITH CHECK (auth.uid() = owner_user_id);
DROP POLICY IF EXISTS "owner update" ON saved_screens;
CREATE POLICY "owner update" ON saved_screens FOR UPDATE USING (auth.uid() = owner_user_id) WITH CHECK (auth.uid() = owner_user_id);
DROP POLICY IF EXISTS "owner delete" ON saved_screens;
CREATE POLICY "owner delete" ON saved_screens FOR DELETE USING (auth.uid() = owner_user_id);

-- A portfolio's selection recipe (filters + weights + topN). Replaces the
-- removed watchlist: the buyer ranks Level 0 via screen_facts() against this
-- and buys the top N.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS screen_config JSONB;


-- ============================================================
-- Portfolio swarm (migration 041 — portfolio page brief §3/§4)
--
-- A portfolio runs a swarm: multiple specialist buyers + reviewers coordinated
-- per cycle (snake-draft buying, first-valid-sell — see swarm.py +
-- agent_heartbeat._run_portfolio_swarm). Per-membership role/remit/knobs;
-- per-portfolio draft settings (opt-in switch for the swarm path); per-position
-- buyer attribution. Backward compatible (NULL role = legacy member).
-- ============================================================
ALTER TABLE portfolio_agents  ADD COLUMN IF NOT EXISTS role   TEXT;   -- 'buyer' | 'reviewer' | 'manager'
ALTER TABLE portfolio_agents  ADD COLUMN IF NOT EXISTS remit  TEXT;   -- free-text specialty/focus
ALTER TABLE portfolio_agents  ADD COLUMN IF NOT EXISTS config JSONB;  -- {convictionGate,maxPerName,cadence,sellRules,brain} + per-instance params
ALTER TABLE portfolio_holdings ADD COLUMN IF NOT EXISTS opened_by_agent_id UUID REFERENCES agents(id);


-- ============================================================
-- Agent team builder (migration 045 — portfolio & agents brief v2)
--
-- The portfolio page becomes the user's home base: drag agents from a library
-- into a team, and saving one deploys it (no mandate, no batch deploy). Library
-- taxonomy on agents (action grouping + declared sell triggers + typed params +
-- a plain-language sentence template), and a per-instance Run/Stop switch on the
-- membership. See migration 045.
-- ============================================================
ALTER TABLE agents ADD COLUMN IF NOT EXISTS action            TEXT;   -- 'buy' | 'sell' | 'manage' (NULL = not a library agent)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS triggers          TEXT[] NOT NULL DEFAULT '{}';   -- declared intent tags (sells)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS param_schema      JSONB  NOT NULL DEFAULT '[]'::jsonb; -- [{key,label,type,min,max,step,unit,default,options}]
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sentence_template TEXT;   -- plain-language description with {key} placeholders
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_action_check;
ALTER TABLE agents ADD  CONSTRAINT agents_action_check
    CHECK (action IS NULL OR action IN ('buy', 'sell', 'manage'));
CREATE INDEX IF NOT EXISTS idx_agents_library ON agents (action) WHERE action IS NOT NULL;

ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;  -- per-instance Run/Stop


-- ============================================================
-- Per-agent mandates (migration 046 — team builder, brief v2)
--
-- Each thinking agent (LLM buyer / reviewer) carries its OWN brief with a
-- baked-in default; the saved instance can override it. Resolution at heartbeat
-- time: instance override ?? agent default ?? (legacy) portfolios.description.
-- Mechanical/manage agents leave default_mandate NULL (no brief field shown).
-- ============================================================
ALTER TABLE agents          ADD COLUMN IF NOT EXISTS default_mandate TEXT;  -- baked-in brief; NULL = mechanical (no brief)
ALTER TABLE portfolio_agents ADD COLUMN IF NOT EXISTS mandate        TEXT;  -- per-instance override; NULL = use agent default
