-- Migration 073: give service_role a real statement timeout so
-- refresh_screen_facts() stops dying at 8s.
--
-- The failure (research-evaluation / verdict-evaluation / prices-daily all
-- end with db.refresh_screen_facts() over PostgREST):
--   57014  canceling statement due to statement timeout   (~8-9s in)
--
-- Why migration 065 didn't fix it, twice over:
--   1. It never took effect in production — the live function has no
--      SET LOCAL line (065 was applied out of band or later overwritten by
--      the 044 definition).
--   2. It COULDN'T have worked anyway: statement_timeout is armed when the
--      top-level statement STARTS. A SET LOCAL executed inside the already-
--      running function never re-arms the timer for that statement — the 8s
--      alarm fires regardless. (Same applies to a function-level SET clause.)
--
-- Where the 8s actually comes from: PostgREST logs in as `authenticator`
-- (rolconfig: statement_timeout=8s) and switches role per request. anon (3s)
-- and authenticated (8s) carry their own per-role overrides, which PostgREST
-- applies on the role switch — but service_role has NONE, so service-role
-- requests inherit authenticator's 8s. The REFRESH MATERIALIZED VIEW
-- CONCURRENTLY diff pass over screen_facts_mv (full-row comparison including
-- the research_card JSONB, now that most Tier-1 names carry cards) grew past
-- that.
--
-- Fix: give service_role its own, larger per-request cap. This is the
-- Supabase-documented mechanism (the same one that makes anon=3s work), it
-- applies BEFORE the statement starts, and it touches only service-role
-- callers — our own server + pipeline; anon/authenticated keep 3s/8s.

ALTER ROLE service_role SET statement_timeout = '120s';

-- PostgREST caches impersonated-role settings; make it re-read them now
-- rather than on its next restart.
NOTIFY pgrst, 'reload config';
