-- Migration 022: extend execute_atomic_buy + execute_atomic_sell to write
-- portfolio_id directly.
--
-- Migration 019 introduced the atomic buy/sell RPCs (row-level locks via
-- SELECT FOR UPDATE in a single transaction). Migration 021 added
-- portfolio_id NOT NULL columns to every trading-shaped table. Between the
-- two, the Python wrapper in portfolio.py had to backfill portfolio_id on
-- agent_holdings / agent_accounts / agent_trades immediately after each
-- RPC call — three extra round-trips and a small race window where the
-- rows briefly exist with portfolio_id = the default from the column's
-- backfill (= agent_id at this point).
--
-- This migration moves portfolio_id resolution into the RPCs themselves.
-- They look up portfolio_id via agent_accounts.portfolio_id (already
-- populated by migration 021) and write it on every INSERT/UPDATE. The
-- Python wrapper's backfill becomes redundant — pure correctness +
-- cleanup, no behaviour change for external callers.
--
-- Function signatures unchanged: same input params, same return shape.

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
    v_portfolio_id   UUID;
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

    -- Lock the account row + read cash + portfolio_id.
    SELECT cash_usd, portfolio_id
        INTO v_current_cash, v_portfolio_id
        FROM agent_accounts
        WHERE agent_id = p_agent_id
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no account for agent %', p_agent_id;
    END IF;
    IF v_portfolio_id IS NULL THEN
        -- Defensive: should never trigger after migration 021's backfill,
        -- but if it does we use the agent_id as the 1:1 shim portfolio_id.
        v_portfolio_id := p_agent_id;
    END IF;

    IF v_current_cash < v_gross_usd THEN
        RETURN jsonb_build_object(
            'status', 'insufficient_cash',
            'cash_usd', v_current_cash,
            'needed_usd', v_gross_usd
        );
    END IF;

    v_new_cash := v_current_cash - v_gross_usd;

    -- Weighted-avg cost basis upsert.
    SELECT quantity, avg_cost_usd
        INTO v_existing_qty, v_existing_cost
        FROM agent_holdings
        WHERE agent_id = p_agent_id AND ticker = p_ticker
        FOR UPDATE;

    IF NOT FOUND THEN
        v_new_qty := p_quantity;
        v_new_avg_cost := p_price_usd;
        INSERT INTO agent_holdings
            (agent_id, portfolio_id, ticker, quantity, avg_cost_usd, first_bought_at, updated_at)
        VALUES
            (p_agent_id, v_portfolio_id, p_ticker, v_new_qty, v_new_avg_cost, NOW(), NOW());
    ELSE
        v_new_qty := v_existing_qty + p_quantity;
        v_new_avg_cost := (v_existing_qty * v_existing_cost + v_gross_usd) / v_new_qty;
        UPDATE agent_holdings
           SET quantity = v_new_qty,
               avg_cost_usd = v_new_avg_cost,
               portfolio_id = v_portfolio_id,
               updated_at = NOW()
         WHERE agent_id = p_agent_id AND ticker = p_ticker;
    END IF;

    -- Deduct cash + ensure portfolio_id stays consistent.
    UPDATE agent_accounts
       SET cash_usd = v_new_cash,
           portfolio_id = v_portfolio_id
     WHERE agent_id = p_agent_id;

    -- Record the trade with portfolio_id populated.
    INSERT INTO agent_trades
        (agent_id, portfolio_id, ticker, side, quantity, price_usd, gross_usd, cash_after_usd, executed_at, note)
    VALUES
        (p_agent_id, v_portfolio_id, p_ticker, 'buy', p_quantity, p_price_usd, v_gross_usd, v_new_cash, NOW(), COALESCE(p_note, ''))
    RETURNING id INTO v_trade_id;

    RETURN jsonb_build_object(
        'status', 'ok',
        'trade_id', v_trade_id,
        'portfolio_id', v_portfolio_id,
        'gross_usd', v_gross_usd,
        'new_cash_usd', v_new_cash,
        'new_quantity', v_new_qty,
        'new_avg_cost_usd', v_new_avg_cost
    );
END;
$$;


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
    v_portfolio_id   UUID;
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

    -- Lock cash row + read portfolio_id.
    SELECT cash_usd, portfolio_id
        INTO v_current_cash, v_portfolio_id
        FROM agent_accounts
        WHERE agent_id = p_agent_id
        FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'no account for agent %', p_agent_id;
    END IF;
    IF v_portfolio_id IS NULL THEN
        v_portfolio_id := p_agent_id;
    END IF;

    -- Lock the holding row + verify quantity.
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

    -- Update or delete the holding.
    IF v_new_qty = 0 THEN
        DELETE FROM agent_holdings
            WHERE agent_id = p_agent_id AND ticker = p_ticker;
    ELSE
        UPDATE agent_holdings
           SET quantity = v_new_qty,
               portfolio_id = v_portfolio_id,
               updated_at = NOW()
         WHERE agent_id = p_agent_id AND ticker = p_ticker;
    END IF;

    -- Credit cash + ensure portfolio_id stays consistent.
    UPDATE agent_accounts
       SET cash_usd = v_new_cash,
           portfolio_id = v_portfolio_id
     WHERE agent_id = p_agent_id;

    -- Record the trade with portfolio_id populated.
    INSERT INTO agent_trades
        (agent_id, portfolio_id, ticker, side, quantity, price_usd, gross_usd, cash_after_usd, executed_at, note)
    VALUES
        (p_agent_id, v_portfolio_id, p_ticker, 'sell', p_quantity, p_price_usd, v_gross_usd, v_new_cash, NOW(), COALESCE(p_note, ''))
    RETURNING id INTO v_trade_id;

    RETURN jsonb_build_object(
        'status', 'ok',
        'trade_id', v_trade_id,
        'portfolio_id', v_portfolio_id,
        'gross_usd', v_gross_usd,
        'new_cash_usd', v_new_cash,
        'remaining_quantity', v_new_qty
    );
END;
$$;


-- Service-role only (matches migration 019).
REVOKE ALL ON FUNCTION execute_atomic_buy  FROM PUBLIC;
REVOKE ALL ON FUNCTION execute_atomic_sell FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_atomic_buy  TO service_role;
GRANT EXECUTE ON FUNCTION execute_atomic_sell TO service_role;
