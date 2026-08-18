-- Migration 084: atomic in-kind sleeve funding.
--
-- Funding a new (or under-funded) sleeve from a sibling sleeve on the SAME
-- broker account can exceed the source's spare cash — the money is locked in
-- positions. The chosen model moves the shortfall IN KIND: a proportional
-- slice of the source sleeve's share records (plus cash) is re-attributed to
-- the destination sleeve. Nothing trades at move time — the broker holds one
-- pooled account and sees no change; only AlphaMolt's split moves. The
-- destination's mirror then restructures the inherited names into its own
-- paper book on its next sync.
--
-- The move touches many rows (N source holdings down, N destination holdings
-- up, two cash balances, two P&L baselines, two ledger legs). A racing
-- heartbeat fill in the same rows could corrupt the split, and a wrong split
-- is unrecoverable (the broker never knew it). So the whole move is ONE
-- transaction in this RPC, with guarded decrements: any quantity that moved
-- underneath us raises and rolls the entire move back — the caller retries,
-- exactly like the web cash actions' optimistic-concurrency RETRY path.
--
-- Baselines: the destination's starting_cash is set to the funded total (its
-- P&L measures from the capital it started with); the source's starting_cash
-- scales by (1 − total/equity_before) so its P&L% stays continuous instead of
-- booking the withdrawal as a loss.
--
-- Style follows execute_portfolio_buy (migrations 025/031). Idempotent
-- (CREATE OR REPLACE). Paste-and-run in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION fund_sleeve_in_kind(
    p_from_portfolio UUID,
    p_to_portfolio   UUID,
    -- [{"ticker": "NVDA", "qty": 1.2345, "avg_cost": 101.5}, ...]
    p_moves          JSONB,
    -- cash leg (>= 0), moved from source allowance to destination allowance
    p_cash           NUMERIC,
    -- total funded value (cash + share value at plan time) — the destination's
    -- starting_cash and the amount both ledger legs record
    p_total          NUMERIC
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

    -- Equity before the move, for the source baseline rescale. Values the
    -- holdings at their recorded avg cost only as a fallback when the caller
    -- passes no market value — the caller's p_total is what actually matters
    -- for the destination; the source rescale needs a consistent "before".
    SELECT COALESCE(SUM(quantity * avg_cost_usd), 0) + v_src_cash
        INTO v_src_equity
        FROM portfolio_holdings
        WHERE portfolio_id = p_from_portfolio;

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
