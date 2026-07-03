-- Migration 071: lock down SECURITY DEFINER RPC grants.
--
-- Supabase's default privileges grant EXECUTE to anon/authenticated whenever
-- a function is (re)created in public — the earlier migrations' REVOKE ...
-- FROM PUBLIC does not remove those direct role grants. That left
-- create_portfolio_funded and refresh_screen_facts callable by ANY caller via
-- /rest/v1/rpc/*, so an anonymous request that knows a user's UUID could
-- create portfolios in their account, or force matview refreshes. Both are
-- only ever called with the service-role key (web server / pipeline).

REVOKE EXECUTE ON FUNCTION create_portfolio_funded(UUID, TEXT, TEXT, TEXT)
    FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION refresh_screen_facts()
    FROM anon, authenticated;

-- Trigger function for auth.users inserts — fires as its owner regardless of
-- who the inserting role is, so it needs no REST-facing EXECUTE at all.
REVOKE EXECUTE ON FUNCTION handle_new_user()
    FROM anon, authenticated;
