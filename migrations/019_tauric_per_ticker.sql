-- Migration 019: Per-ticker evaluation pipeline for the trading_agents strategy.
--
-- Two related additions:
--
-- (1) `tauric_decisions` — persisted journal of every per-ticker framework
--     verdict + the trade outcome it produced. One row per
--     (agent_id, shortlist_run_id, ticker) so a heartbeat can be
--     resumed mid-flight: tickers with status='traded' are skipped,
--     status='pending' rows still need work. Makes the in-flight pipeline
--     observable from the DB (and from the agent profile page eventually).
--
-- (2) `execute_atomic_buy` / `execute_atomic_sell` — Supabase RPCs that
--     wrap cash-deduct + holding-upsert + trade-insert in a single PG
--     transaction with row-level locks (SELECT FOR UPDATE on
--     agent_accounts). Removes the existing single-writer-per-agent
--     constraint that the Python PortfolioManager imposed: matrix jobs
--     in the new per-ticker workflow can run in parallel without racing
--     on cash. Reproduces PortfolioManager's weighted-avg cost basis
--     and noise-trade semantics exactly.
--
-- Idempotent — re-running creates nothing twice. The Python
-- PortfolioManager.buy() / sell() flow stays as-is for backwards
-- compatibility; new callers opt into the atomic RPCs explicitly via
-- PortfolioManager.buy_atomic() / sell_atomic() (added in the same PR).


-- ============================================================
-- Per-ticker decision journal
-- ============================================================
CREATE TABLE IF NOT EXISTS tauric_decisions (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id             UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    shortlist_run_id     UUID NOT NULL,
    ticker               TEXT NOT NULL REFERENCES companies(ticker) ON DELETE CASCADE,

    -- Lifecycle: pending → evaluating → decided → traded
    --                                         → error (terminal)
    status               TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','evaluating','decided','traded','error')),

    -- Stage 1 shortlist artefact
    shortlist_rationale  TEXT,

    -- Stage 2 framework output
    decision             TEXT CHECK (decision IN ('BUY','SELL','HOLD')),
    reasoning            TEXT,                  -- truncated framework debate excerpt
    framework_error      TEXT,                  -- non-null when status='error'

    -- Stage 3 trade outcome
    trade_outcome        TEXT CHECK (trade_outcome IN (
                            'bought',
                            'sold',
                            'skipped_hold',
                            'skipped_no_cash',
                            'skipped_no_position',
                            'skipped_build_mode_sell',
                            'skipped_noise',
                            'skipped_unpriced'
                         )),
    trade_id             BIGINT REFERENCES agent_trades(id) ON DELETE SET NULL,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at           TIMESTAMPTZ,
    traded_at            TIMESTAMPTZ,

    UNIQUE (agent_id, shortlist_run_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_tauric_decisions_run
    ON tauric_decisions (shortlist_run_id);
CREATE INDEX IF NOT EXISTS idx_tauric_decisions_agent_status
    ON tauric_decisions (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tauric_decisions_ticker
    ON tauric_decisions (ticker);


-- ============================================================
-- Atomic BUY — locks agent_accounts, deducts cash, upserts holding,
-- inserts trade row, returns JSONB summary.
-- ============================================================
CREATE OR REPLACE FUNCTION execute_atomic_buy(
    p_agent_id   UUID,
    p_ticker     TEXT,
    p_quantity   NUMERIC,
    p_price_usd  NUMERIC,
    p_note       TEXT DEFAULT ''
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_gross_usd      NUMERIC;
    v_current_cash   NUMERIC;
    v_new_cash       NUMERIC;
    v_existing_qty   NUMERIC;
    v_existing_cost  NUMERIC;
    v_new_qty        NUMERIC;
    v_new_avg_cost   NUMERIC;
    v_trade_id       BIGINT;
BEGIN
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION 'quantity must be > 0 (got %)', p_quantity;
    END IF;
    IF p_price_usd <= 0 THEN
        RAISE EXCEPTION 'price_usd must be > 0 (got %)', p_price_usd;
    END IF;

    v_gross_usd := p_quantity * p_price_usd;

    -- Lock the account row + read cash
    SELECT cash_usd INTO v_current_cash
        FROM agent_accounts
        WHERE agent_id = p_agent_id
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no account for agent %', p_agent_id;
    END IF;

    IF v_current_cash < v_gross_usd THEN
        RETURN jsonb_build_object(
            'status', 'insufficient_cash',
            'cash_usd', v_current_cash,
            'needed_usd', v_gross_usd
        );
    END IF;

    v_new_cash := v_current_cash - v_gross_usd;

    -- Weighted-avg cost basis upsert
    SELECT quantity, avg_cost_usd
        INTO v_existing_qty, v_existing_cost
        FROM agent_holdings
        WHERE agent_id = p_agent_id AND ticker = p_ticker
        FOR UPDATE;

    IF NOT FOUND THEN
        v_new_qty := p_quantity;
        v_new_avg_cost := p_price_usd;
        INSERT INTO agent_holdings
            (agent_id, ticker, quantity, avg_cost_usd, first_bought_at, updated_at)
        VALUES
            (p_agent_id, p_ticker, v_new_qty, v_new_avg_cost, NOW(), NOW());
    ELSE
        v_new_qty := v_existing_qty + p_quantity;
        v_new_avg_cost := (v_existing_qty * v_existing_cost + v_gross_usd) / v_new_qty;
        UPDATE agent_holdings
           SET quantity = v_new_qty,
               avg_cost_usd = v_new_avg_cost,
               updated_at = NOW()
         WHERE agent_id = p_agent_id AND ticker = p_ticker;
    END IF;

    -- Deduct cash
    UPDATE agent_accounts
       SET cash_usd = v_new_cash
     WHERE agent_id = p_agent_id;

    -- Record the trade
    INSERT INTO agent_trades
        (agent_id, ticker, side, quantity, price_usd, gross_usd, cash_after_usd, executed_at, note)
    VALUES
        (p_agent_id, p_ticker, 'buy', p_quantity, p_price_usd, v_gross_usd, v_new_cash, NOW(), COALESCE(p_note, ''))
    RETURNING id INTO v_trade_id;

    RETURN jsonb_build_object(
        'status', 'ok',
        'trade_id', v_trade_id,
        'gross_usd', v_gross_usd,
        'new_cash_usd', v_new_cash,
        'new_quantity', v_new_qty,
        'new_avg_cost_usd', v_new_avg_cost
    );
END;
$$;


-- ============================================================
-- Atomic SELL — locks agent_accounts + agent_holdings, decrements
-- quantity (or deletes if going to zero), credits cash, inserts trade.
-- ============================================================
CREATE OR REPLACE FUNCTION execute_atomic_sell(
    p_agent_id   UUID,
    p_ticker     TEXT,
    p_quantity   NUMERIC,
    p_price_usd  NUMERIC,
    p_note       TEXT DEFAULT ''
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_gross_usd      NUMERIC;
    v_current_cash   NUMERIC;
    v_new_cash       NUMERIC;
    v_existing_qty   NUMERIC;
    v_existing_cost  NUMERIC;
    v_new_qty        NUMERIC;
    v_trade_id       BIGINT;
BEGIN
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION 'quantity must be > 0 (got %)', p_quantity;
    END IF;
    IF p_price_usd <= 0 THEN
        RAISE EXCEPTION 'price_usd must be > 0 (got %)', p_price_usd;
    END IF;

    v_gross_usd := p_quantity * p_price_usd;

    -- Lock cash row
    SELECT cash_usd INTO v_current_cash
        FROM agent_accounts
        WHERE agent_id = p_agent_id
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no account for agent %', p_agent_id;
    END IF;

    -- Lock the holding row + verify quantity
    SELECT quantity, avg_cost_usd
        INTO v_existing_qty, v_existing_cost
        FROM agent_holdings
        WHERE agent_id = p_agent_id AND ticker = p_ticker
        FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'status', 'no_position',
            'ticker', p_ticker
        );
    END IF;

    IF v_existing_qty < p_quantity THEN
        RETURN jsonb_build_object(
            'status', 'insufficient_quantity',
            'held_quantity', v_existing_qty,
            'requested_quantity', p_quantity
        );
    END IF;

    v_new_qty := v_existing_qty - p_quantity;
    v_new_cash := v_current_cash + v_gross_usd;

    -- Update or delete the holding
    IF v_new_qty = 0 THEN
        DELETE FROM agent_holdings
            WHERE agent_id = p_agent_id AND ticker = p_ticker;
    ELSE
        UPDATE agent_holdings
           SET quantity = v_new_qty,
               updated_at = NOW()
         WHERE agent_id = p_agent_id AND ticker = p_ticker;
    END IF;

    -- Credit cash
    UPDATE agent_accounts
       SET cash_usd = v_new_cash
     WHERE agent_id = p_agent_id;

    -- Record the trade
    INSERT INTO agent_trades
        (agent_id, ticker, side, quantity, price_usd, gross_usd, cash_after_usd, executed_at, note)
    VALUES
        (p_agent_id, p_ticker, 'sell', p_quantity, p_price_usd, v_gross_usd, v_new_cash, NOW(), COALESCE(p_note, ''))
    RETURNING id INTO v_trade_id;

    RETURN jsonb_build_object(
        'status', 'ok',
        'trade_id', v_trade_id,
        'gross_usd', v_gross_usd,
        'new_cash_usd', v_new_cash,
        'remaining_quantity', v_new_qty
    );
END;
$$;


-- ============================================================
-- Service-role only — these RPCs mutate financial state.
-- ============================================================
REVOKE ALL ON FUNCTION execute_atomic_buy  FROM PUBLIC;
REVOKE ALL ON FUNCTION execute_atomic_sell FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_atomic_buy  TO service_role;
GRANT EXECUTE ON FUNCTION execute_atomic_sell TO service_role;
