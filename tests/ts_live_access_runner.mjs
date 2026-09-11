// Runner for the /live console's access rule (web/lib/live-access.ts).
//
// The case that matters is the one that shipped broken. The page was merged
// before its migration ran, so `select live_access` failed on a column that
// did not exist yet. Both reads sat in one try/catch, so that throw discarded
// the OWNERSHIP answer too, and every owner of a real live account was 404'd
// out of their own console by the absence of a flag that has nothing to do
// with them.
//
// The two grants are independent by design, so they must fail independently —
// while neither may ever be granted by a read that failed.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_live_access_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { hasLiveAccess, resolveLiveAccess } = await import(
  join(here, "..", "web", "lib", "live-access-rule.ts")
);

process.stdout.write(
  JSON.stringify({
    // The rule itself: either grant is sufficient, neither is necessary.
    rule: {
      flagOnly: hasLiveAccess({ liveAccessFlag: true, livePortfolioCount: 0 }),
      ownershipOnly: hasLiveAccess({ liveAccessFlag: false, livePortfolioCount: 1 }),
      both: hasLiveAccess({ liveAccessFlag: true, livePortfolioCount: 2 }),
      neither: hasLiveAccess({ liveAccessFlag: false, livePortfolioCount: 0 }),
    },
    // null = that read failed. The production regression is `flagUnreadable`.
    degraded: {
      flagUnreadableButOwnsOne: resolveLiveAccess(null, 1),
      flagUnreadableAndOwnsNone: resolveLiveAccess(null, 0),
      ownershipUnreadableButFlagged: resolveLiveAccess(true, null),
      ownershipUnreadableUnflagged: resolveLiveAccess(false, null),
      bothUnreadable: resolveLiveAccess(null, null),
    },
  }),
);
