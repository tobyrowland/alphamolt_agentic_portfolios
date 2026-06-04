-- Migration 039: Level 0 — strategy-neutral universe & fact store.
--
-- A single, strategy-neutral store of facts about all liquid US equities.
-- It is invisible to users; every visible surface (screener, company pages,
-- lens scoring, agents) reads from it. See the alphamolt Level 0 spec.
--
-- THE LINE THAT MUST HOLD: Level 0 contains FACTS, never STRATEGY. No
-- margin/growth/valuation/sector OPINIONS live here — those are lenses applied
-- downstream. The only gate Level 0 applies is strategy-neutral AFFORDABILITY
-- (liquidity + has-data + valid listing — see securities.is_tier1 / spec §6).
--
-- Two-tier model:
--   * Tier 0 — reference universe: every US-listed common stock + ADRs + REITs
--     (units, warrants, preferreds, SPACs excluded). Identity-level only, cheap,
--     slow-changing, status-tracked. Soft-delete on delisting — never hard-delete;
--     delisted names keep their history (status='delisted').
--   * Tier 1 — enriched/active set: the subset passing the affordability gate
--     that receives full enrichment (prices, fundamentals, valuation). This is
--     where compute is spent. Flagged by securities.is_tier1.
--
-- Every fact-bearing row carries `source` and an as-of date (`fetched_at` and/or
-- `period_end`/`date`) for zero-hallucination. Latest values stamped with their
-- as-of date — NOT full historical point-in-time reconstruction (spec §12).
--
-- These tables are ADDITIVE: the existing companies / price_sales pipeline is
-- untouched. The old opinionated TradingView screen becomes one lens applied on
-- top of Tier 1, downstream.
--
-- Idempotent: re-runnable (CREATE TABLE IF NOT EXISTS, upserts on the PKs).

-- ============================================================
-- securities — Tier 0 identity (the reference universe)
-- ============================================================
CREATE TABLE IF NOT EXISTS securities (
    ticker              TEXT PRIMARY KEY,
    name                TEXT,
    exchange            TEXT,
    cik                 TEXT,          -- SEC Central Index Key (ticker↔CIK↔name)
    figi                TEXT,
    isin                TEXT,
    security_type       TEXT,          -- 'Common Stock' | 'ADR' | 'REIT'
    gics_sector         TEXT,
    gics_industry       TEXT,
    country             TEXT,
    share_class         TEXT,          -- dual-class marker, e.g. GOOG vs GOOGL

    status              TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'delisted'

    ipo_date            DATE,
    first_seen          DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen           DATE NOT NULL DEFAULT CURRENT_DATE,

    -- Tier 1 membership + the strategy-neutral affordability gate inputs that
    -- decided it (stamped for transparency; recomputed weekly).
    is_tier1            BOOLEAN NOT NULL DEFAULT FALSE,
    addv_30d            NUMERIC,       -- avg daily dollar volume, trailing 30d
    last_close          NUMERIC,       -- last close used by the gate
    tier1_evaluated_at  TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_securities_status   ON securities (status);
CREATE INDEX IF NOT EXISTS idx_securities_tier1    ON securities (is_tier1) WHERE is_tier1;
CREATE INDEX IF NOT EXISTS idx_securities_sector   ON securities (gics_sector);
CREATE INDEX IF NOT EXISTS idx_securities_type     ON securities (security_type);

DROP TRIGGER IF EXISTS securities_updated_at ON securities;
CREATE TRIGGER securities_updated_at
    BEFORE UPDATE ON securities
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- prices_daily — the Pareto king (technicals, valuation-over-time, liquidity)
-- 2y of history per Tier 1 ticker.
-- ============================================================
CREATE TABLE IF NOT EXISTS prices_daily (
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    date            DATE NOT NULL,
    open            NUMERIC,
    high            NUMERIC,
    low             NUMERIC,
    close           NUMERIC,
    adj_close       NUMERIC,           -- split/dividend-adjusted
    volume          BIGINT,
    dollar_volume   NUMERIC,           -- close * volume (powers the liquidity gate)
    PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_prices_daily_date ON prices_daily (date);

-- ============================================================
-- fundamentals — keep HISTORY, not just the current snapshot.
-- One row per (ticker, period_end); never overwrite history — append a new
-- period_end on each new filing.
-- ============================================================
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

    PRIMARY KEY (ticker, period_end)
);

CREATE INDEX IF NOT EXISTS idx_fundamentals_period ON fundamentals (period_end);

-- ============================================================
-- valuation — multiples + series. One row per (ticker, date). The P/S summary
-- columns (52w hi/lo, 12m median, ATH) + history_json mirror the existing
-- price_sales semantics and are meaningful on the latest dated row.
-- ============================================================
CREATE TABLE IF NOT EXISTS valuation (
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    date            DATE NOT NULL,
    ps              NUMERIC,
    pe              NUMERIC,
    ev_sales        NUMERIC,
    p_fcf           NUMERIC,

    -- P/S distribution context (carried on the latest row; mirrors price_sales)
    ps_high_52w     NUMERIC,
    ps_low_52w      NUMERIC,
    ps_median_12m   NUMERIC,
    ps_ath          NUMERIC,
    ps_pct_of_ath   NUMERIC,
    history_json    JSONB,             -- rolling [[date, ps], ...] series

    source          TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticker, date)
);

CREATE INDEX IF NOT EXISTS idx_valuation_date ON valuation (date);

-- ============================================================
-- estimates — optional, high value/cost. Latest snapshot per ticker.
-- ============================================================
CREATE TABLE IF NOT EXISTS estimates (
    ticker              TEXT PRIMARY KEY REFERENCES securities(ticker) ON DELETE CASCADE,
    consensus_rating    TEXT,
    price_target        NUMERIC,
    eps_revisions_4w    NUMERIC,
    source              TEXT,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- events — next + past earnings, splits, ex-div.
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
    ticker          TEXT NOT NULL REFERENCES securities(ticker) ON DELETE CASCADE,
    type            TEXT NOT NULL,     -- 'earnings' | 'split' | 'dividend'
    date            DATE NOT NULL,
    value           NUMERIC,           -- split ratio / dividend amount / eps (type-dependent)
    source          TEXT,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticker, type, date)
);

CREATE INDEX IF NOT EXISTS idx_events_ticker_date ON events (ticker, date);
CREATE INDEX IF NOT EXISTS idx_events_type_date   ON events (type, date);

-- ============================================================
-- RLS — public read, service-role-only writes (matches migrations 020 / 038).
-- These are facts; the website reads them with the anon key, the pipeline
-- writes them with the service-role key (which bypasses RLS).
-- ============================================================
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
