-- Migration 052: repoint the trading tables' ticker FK from companies -> securities.
--
-- The trading tables (portfolio_holdings, agent_holdings, agent_trades,
-- investment_theses) constrained `ticker` to companies(ticker) — the legacy
-- TradingView-screen universe. That blocked the buyer from ever holding /
-- journaling a Tier-1 name the legacy pipeline never covered (US-listed
-- financials, foreign-domiciled ADRs like TSM/ING), even though the screener
-- ranks them and the buyer (post-PR #1596) now evaluates them: the buy RPC
-- hit a foreign-key violation.
--
-- securities (Level 0, migration 039) is the universe of record now and a
-- superset of companies (every US-exchange-listed name). Repointing the FK
-- there keeps real referential integrity (no booking a garbage symbol) while
-- letting the full Tier-1 universe be traded.
--
-- SAFE BY DESIGN:
--   * securities soft-deletes (status='delisted'), never hard-deletes, so the
--     FK target for a historical trade on a now-delisted name still exists.
--   * The new constraint is added NOT VALID — existing rows are grandfathered
--     (never re-checked), so the migration can't fail on legacy data that
--     predates the securities universe. Only NEW inserts are checked, which is
--     exactly what we want: a new buy must reference a known security.
--
-- Idempotent: drops whatever FK currently points ticker->companies on each
-- table, then adds the securities FK if not already present. Paste-and-run.

DO $$
DECLARE
    t        TEXT;
    conname  TEXT;
    tables   TEXT[] := ARRAY[
        'portfolio_holdings', 'agent_holdings', 'agent_trades', 'investment_theses'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        -- 1. Drop the existing ticker->companies FK (whatever it's named).
        FOR conname IN
            SELECT c.conname
            FROM pg_constraint c
            WHERE c.conrelid = t::regclass
              AND c.contype = 'f'
              AND c.confrelid = 'companies'::regclass
              AND (SELECT a.attname
                     FROM pg_attribute a
                    WHERE a.attrelid = c.conrelid
                      AND a.attnum = c.conkey[1]) = 'ticker'
        LOOP
            EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, conname);
            RAISE NOTICE 'dropped % on %', conname, t;
        END LOOP;

        -- 2. Add the securities FK (NOT VALID → grandfathers existing rows).
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint c
            WHERE c.conrelid = t::regclass
              AND c.contype = 'f'
              AND c.confrelid = 'securities'::regclass
              AND (SELECT a.attname
                     FROM pg_attribute a
                    WHERE a.attrelid = c.conrelid
                      AND a.attnum = c.conkey[1]) = 'ticker'
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I '
                'FOREIGN KEY (ticker) REFERENCES securities(ticker) NOT VALID',
                t, t || '_ticker_securities_fkey'
            );
            RAISE NOTICE 'added %_ticker_securities_fkey on %', t, t;
        END IF;
    END LOOP;
END $$;
