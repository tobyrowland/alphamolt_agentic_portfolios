-- Migration 085: value the in-kind rescale at market, not at cost.
--
-- Migration 084 rescales the SOURCE sleeve's P&L baseline when value moves out
-- of it, so a withdrawal reads as a withdrawal instead of a loss:
--
--     starting_cash := starting_cash * (1 - moved / equity_before)
--
-- The intent is right and the arithmetic is right; the two inputs were simply
-- measured on different rulers. `p_total` (the numerator) is MARKET value —
-- the caller prices every share leg at `securities.price` before planning the
-- move. `v_src_equity` (the denominator) was computed here as COST BASIS,
-- `SUM(quantity * avg_cost_usd) + cash`. On a sleeve trading well above cost
-- the denominator is far too small, so the baseline is cut by more than the
-- share of value that actually left, and the remaining sleeve's P&L% jumps.
--
-- Observed in production: a $10,000 move out of a $27,661.42 sleeve should
-- have left its return at 106.03% exactly (that is what "continuous" means).
-- It reported 110.41% instead, implying an equity of ~$26,684 — the cost
-- basis, not the market value.
--
-- The fix is to let the caller pass the market equity it already computed
-- (`p_src_equity`), which is what 084's own comment claimed to do but never
-- implemented. The cost-basis sum stays as the fallback for a caller that
-- can't price the book, since a slightly wrong rescale beats none at all.
--
-- Nothing else changes: destination semantics (starting_cash += p_total,
-- deposit semantics), the guarded decrements, the locking order and both
-- ledger legs are byte-for-byte 084.
--
-- The old 5-argument signature is dropped first — leaving it in place would
-- make a 5-argument call ambiguous against the new one's default, and
-- PostgREST would have no way to choose. Paste-and-run in the Supabase SQL
-- editor, then `NOTIFY pgrst, 'reload schema';`.

DROP FUNCTION IF EXISTS fund_sleeve_in_kind(UUID, UUID, JSONB, NUMERIC, NUMERIC);

CREATE OR REPLACE FUNCTION fund_sleeve_in_kind(
    p_from_portfolio UUID,
    p_to_portfolio   UUID,
    -- [{"ticker": "NVDA", "qty": 1.2345, "avg_cost": 101.5}, ...]
    p_moves          JSONB,
    -- cash leg (>= 0), moved from source allowance to destination allowance
    p_cash           NUMERIC,
    -- total funded value (cash + share value at plan time) — the destination's
    -- starting_cash and the amount both ledger legs record
    p_total          NUMERIC,
    -- the source sleeve's MARKET equity before the move (cash + holdings at
    -- current prices). Measured on the same ruler as p_total, so the baseline
    -- rescale below is exact. NULL falls back to cost basis.
    p_src_equity     NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_move            RECORD;
    v_src_qty         NUMERIC;
    v_src_cost        NUMERIC;
    v_dst_qty         NUMERIC;
    v_dst_cost        NUMERIC;
    v_src_cash        NUMERIC;
    v_dst_cash        NUMERIC;
    v_dst_starting    NUMERIC;
    v_src_starting    NUMERIC;
    v_src_equity      NUMERIC;
    v_moved_value     NUMERIC := 0;
    v_from_slug       TEXT;
    v_to_slug         TEXT;
BEGIN
    IF p_from_portfolio = p_to_portfolio THEN
        RAISE EXCEPTION 'source and destination are the same portfolio';
    END IF;
    IF p_cash < 0 OR p_total <= 0 THEN
        RAISE EXCEPTION 'cash must be >= 0 and total > 0 (got %, %)',
            p_cash, p_total;
    END IF;

    SELECT slug INTO v_from_slug FROM portfolios WHERE id = p_from_portfolio;
    SELECT slug INTO v_to_slug   FROM portfolios WHERE id = p_to_portfolio;
    IF v_from_slug IS NULL OR v_to_slug IS NULL THEN
        RAISE EXCEPTION 'unknown portfolio';
    END IF;

    -- Lock both cash rows up front (stable order: source then destination) so
    -- concurrent RPC calls serialize instead of deadlocking.
    SELECT cash_usd, starting_cash INTO v_src_cash, v_src_starting
        FROM portfolio_accounts
        WHERE portfolio_id = p_from_portfolio
        FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no account for source portfolio %', p_from_portfolio;
    END IF;
    SELECT cash_usd, starting_cash INTO v_dst_cash, v_dst_starting
        FROM portfolio_accounts
        WHERE portfolio_id = p_to_portfolio
        FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no account for destination portfolio %', p_to_portfolio;
    END IF;

    IF p_cash > v_src_cash + 0.01 THEN
        -- The plan was built against a stale balance (a fill landed since).
        RAISE EXCEPTION 'source cash moved: have %, plan needs % — retry',
            v_src_cash, p_cash;
    END IF;

    -- Equity before the move, for the source baseline rescale. MUST be measured
    -- the same way as p_total or the rescale is wrong by the sleeve's unrealised
    -- gain: p_total prices the share legs at market, so the caller's market
    -- equity is the right denominator. Cost basis is the fallback for a caller
    -- that can't price the book (it under-states equity, so it over-cuts the
    -- baseline — better than not rescaling, but not correct).
    IF p_src_equity IS NOT NULL AND p_src_equity > 0 THEN
        v_src_equity := p_src_equity;
    ELSE
        SELECT COALESCE(SUM(quantity * avg_cost_usd), 0) + v_src_cash
            INTO v_src_equity
            FROM portfolio_holdings
            WHERE portfolio_id = p_from_portfolio;
    END IF;

    -- Share legs: guarded decrement per move — any mismatch rolls it all back.
    FOR v_move IN
        SELECT (m->>'ticker')            AS ticker,
               (m->>'qty')::NUMERIC      AS qty,
               (m->>'avg_cost')::NUMERIC AS avg_cost
        FROM jsonb_array_elements(p_moves) AS m
    LOOP
        IF v_move.qty <= 0 THEN
            RAISE EXCEPTION 'move qty must be > 0 for %', v_move.ticker;
        END IF;

        SELECT quantity, avg_cost_usd INTO v_src_qty, v_src_cost
            FROM portfolio_holdings
            WHERE portfolio_id = p_from_portfolio AND ticker = v_move.ticker
            FOR UPDATE;
        IF NOT FOUND OR v_src_qty < v_move.qty - 0.0001 THEN
            RAISE EXCEPTION
                'source holds % of % but the plan moves % — retry',
                COALESCE(v_src_qty, 0), v_move.ticker, v_move.qty;
        END IF;

        IF v_src_qty - v_move.qty <= 0.0001 THEN
            DELETE FROM portfolio_holdings
                WHERE portfolio_id = p_from_portfolio
                  AND ticker = v_move.ticker;
        ELSE
            UPDATE portfolio_holdings
                SET quantity = v_src_qty - v_move.qty, updated_at = NOW()
                WHERE portfolio_id = p_from_portfolio
                  AND ticker = v_move.ticker;
        END IF;

        -- Destination: weighted-average cost when it already holds the name.
        SELECT quantity, avg_cost_usd INTO v_dst_qty, v_dst_cost
            FROM portfolio_holdings
            WHERE portfolio_id = p_to_portfolio AND ticker = v_move.ticker
            FOR UPDATE;
        IF NOT FOUND THEN
            INSERT INTO portfolio_holdings
                (portfolio_id, ticker, quantity, avg_cost_usd,
                 first_bought_at, updated_at)
            VALUES
                (p_to_portfolio, v_move.ticker, v_move.qty,
                 COALESCE(v_move.avg_cost, v_src_cost), NOW(), NOW());
        ELSE
            UPDATE portfolio_holdings
                SET quantity = v_dst_qty + v_move.qty,
                    avg_cost_usd =
                        (v_dst_qty * v_dst_cost
                         + v_move.qty * COALESCE(v_move.avg_cost, v_src_cost))
                        / (v_dst_qty + v_move.qty),
                    updated_at = NOW()
                WHERE portfolio_id = p_to_portfolio
                  AND ticker = v_move.ticker;
        END IF;

        v_moved_value := v_moved_value
            + v_move.qty * COALESCE(v_move.avg_cost, v_src_cost);
    END LOOP;

    -- Cash + baselines. Destination baseline = the funded total; source
    -- baseline scales so its P&L%% doesn't book the withdrawal as a loss.
    UPDATE portfolio_accounts
        SET cash_usd = v_src_cash - p_cash,
            starting_cash = CASE
                WHEN v_src_equity > p_total AND v_src_starting IS NOT NULL
                    THEN ROUND(v_src_starting * (1 - p_total / v_src_equity), 2)
                ELSE v_src_starting
            END,
            updated_at = NOW()
        WHERE portfolio_id = p_from_portfolio;

    -- Destination baseline grows by the funded amount (deposit semantics):
    -- a brand-new sleeve (seeded starting_cash = 0) ends at exactly p_total;
    -- topping up an existing sleeve raises its baseline rather than
    -- clobbering its P&L history.
    UPDATE portfolio_accounts
        SET cash_usd = v_dst_cash + p_cash,
            starting_cash = COALESCE(v_dst_starting, 0) + ROUND(p_total, 2),
            updated_at = NOW()
        WHERE portfolio_id = p_to_portfolio;

    INSERT INTO portfolio_cash_ledger
        (portfolio_id, delta_usd, balance_after, reason, note)
    VALUES
        (p_from_portfolio, -ROUND(p_total, 2), ROUND(v_src_cash - p_cash, 2),
         'fund-in-kind-out',
         'shares + cash → ' || v_to_slug),
        (p_to_portfolio, ROUND(p_total, 2), ROUND(v_dst_cash + p_cash, 2),
         'fund-in-kind-in',
         'shares + cash ← ' || v_from_slug);

    RETURN jsonb_build_object(
        'status', 'ok',
        'cash_moved', p_cash,
        'moved_value_at_cost', ROUND(v_moved_value, 2),
        'total', p_total
    );
END;
$$;
