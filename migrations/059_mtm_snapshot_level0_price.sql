-- Migration 059: MTM snapshot reads Level 0 price (companies retirement, phase 1).
--
-- `recompute_portfolio_snapshot()` (fired by the agent_trades trigger to value a
-- legacy agent portfolio) valued holdings off `companies.price`. Repoint it to
-- the Level 0 price home (`securities.price`, migration 058) so it no longer
-- depends on `companies`. Falls back to the position's avg cost when no live
-- price exists — same behaviour as before, just a different price source.
--
-- Idempotent (CREATE OR REPLACE). Apply AFTER migration 058 (needs
-- securities.price to exist + be backfilled).

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
