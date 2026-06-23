-- Migration 065: stop refresh_screen_facts() hitting the API statement timeout.
--
-- refresh_screen_facts() does REFRESH MATERIALIZED VIEW CONCURRENTLY over the
-- ~3k-row, multi-LATERAL-join screen_facts_mv. Called over PostgREST (the daily
-- Level 0 price job / db.refresh_screen_facts()), it inherits the API role's
-- short statement_timeout (Supabase caps it at ~8s), so the rebuild dies with:
--   57014  canceling statement due to statement timeout
--
-- The matview is correct; the only problem is the cap. This SECURITY DEFINER
-- function raises statement_timeout for its own transaction (statement_timeout
-- is USERSET, and SET LOCAL scopes the change to this call only — it never
-- relaxes the cap for any other API query). CONCURRENTLY is kept so screener
-- reads are never blocked during the rebuild.
--
-- Idempotent: CREATE OR REPLACE, no schema change.

CREATE OR REPLACE FUNCTION public.refresh_screen_facts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    -- Lift the API role's short timeout for just this rebuild (this transaction
    -- only). 0 = no limit; the refresh runs to completion.
    SET LOCAL statement_timeout = 0;
    REFRESH MATERIALIZED VIEW CONCURRENTLY screen_facts_mv;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refresh_screen_facts() TO service_role;
