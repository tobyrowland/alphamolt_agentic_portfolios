-- sell_clov_omda_hny.sql — owner-initiated full sell of CLOV, OMDA, HNY from
-- test-portfolio-toby at current price. Paste-and-run in the Supabase SQL editor.
--
-- Mirrors the website's owner "Sell" path (sellHolding): attributes the trade
-- to the `manual` house agent, journals agent_trades, credits cash, deletes
-- the holding, and closes any active investment_theses. Unlike the website
-- button it prices via the Python get_price fallback
-- (companies.price -> prices_daily latest close -> securities.last_close), so
-- it works for Level-0-only names too.
--
-- Safe to re-run: an already-sold (or unheld) name just logs SKIP.

DO $$
DECLARE
    v_pid   UUID;
    v_agent UUID;
    v_tkr   TEXT;
    v_qty   NUMERIC;
    v_price NUMERIC;
    v_res   JSONB;
    tickers TEXT[] := ARRAY['CLOV','OMDA','HNY'];
BEGIN
    SELECT id INTO v_pid   FROM portfolios WHERE slug = 'test-portfolio-toby';
    IF v_pid IS NULL THEN RAISE EXCEPTION 'portfolio test-portfolio-toby not found'; END IF;
    SELECT id INTO v_agent FROM agents WHERE handle = 'manual' LIMIT 1;
    IF v_agent IS NULL THEN RAISE EXCEPTION 'manual house agent not found'; END IF;

    FOREACH v_tkr IN ARRAY tickers LOOP
        SELECT quantity INTO v_qty
          FROM portfolio_holdings
         WHERE portfolio_id = v_pid AND ticker = v_tkr;
        IF v_qty IS NULL OR v_qty <= 0 THEN
            RAISE NOTICE 'SKIP % — not held by test-portfolio-toby', v_tkr;  CONTINUE;
        END IF;

        -- current price: companies.price -> prices_daily latest -> securities.last_close
        v_price := COALESCE(
            (SELECT price      FROM companies    WHERE ticker = v_tkr AND price > 0),
            (SELECT close      FROM prices_daily  WHERE ticker = v_tkr AND close > 0 ORDER BY date DESC LIMIT 1),
            (SELECT last_close FROM securities    WHERE ticker = v_tkr AND last_close > 0)
        );
        IF v_price IS NULL OR v_price <= 0 THEN
            RAISE NOTICE 'SKIP % — no usable current price', v_tkr;  CONTINUE;
        END IF;

        v_res := execute_portfolio_sell(v_pid, v_agent, v_tkr, v_qty, round(v_price, 4),
                                        'owner-initiated full sell');
        RAISE NOTICE 'SOLD % x% @ % -> %', v_tkr, v_qty, round(v_price, 4), v_res;

        UPDATE investment_theses
           SET status = 'closed', status_changed_at = NOW(), closed_at = NOW()
         WHERE portfolio_id = v_pid AND ticker = v_tkr AND status = 'active';
    END LOOP;
END $$;

-- Verify (run after):
-- SELECT ticker, side, quantity, price_usd, gross_usd, executed_at
-- FROM agent_trades
-- WHERE portfolio_id = (SELECT id FROM portfolios WHERE slug='test-portfolio-toby')
--   AND ticker IN ('CLOV','OMDA','HNY') AND side='sell'
-- ORDER BY executed_at DESC;
--
-- SELECT ticker FROM portfolio_holdings
-- WHERE portfolio_id = (SELECT id FROM portfolios WHERE slug='test-portfolio-toby')
--   AND ticker IN ('CLOV','OMDA','HNY');   -- expect 0 rows
