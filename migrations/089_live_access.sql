-- 089: who may open /live.
--
-- The live console moves real money, so it is not a page every signed-in
-- visitor should reach. Access is EITHER of two things:
--
--   1. the user owns at least one mode='live' portfolio, or
--   2. profiles.live_access is true.
--
-- (1) alone would be enough for today's users and needs no column: a live
-- follower only exists after an operator runs the go-live flow, so holding one
-- already proves provisioning. The flag exists for the case (1) cannot serve —
-- showing the console to someone BEFORE they are provisioned (a beta cohort,
-- or an owner mid-onboarding whose follower row is not created yet). Neither
-- rule subsumes the other, so the resolver takes the OR of both
-- (web/lib/live-access.ts).
--
-- Deliberately NOT a role or a policy table: this gates one page, and a
-- boolean that an operator sets with one UPDATE is the whole requirement. A
-- permissions system can replace it when there is a second thing to gate.
--
-- Default false — the page stays closed for everyone it is not opened for,
-- including every existing row. Users who already hold a live portfolio keep
-- their access through rule (1) without any backfill.
alter table profiles
  add column if not exists live_access boolean not null default false;

comment on column profiles.live_access is
  'Operator grant for the /live console, independent of owning a live '
  'portfolio. Access = this flag OR owning a mode=''live'' portfolio.';
