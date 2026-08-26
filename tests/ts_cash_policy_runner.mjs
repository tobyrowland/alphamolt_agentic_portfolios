// Cross-language parity runner for the owner cash policy (migration 088).
//
// web/lib/cash-policy.ts is the twin of cash_policy.py, and the save action
// (`setPortfolioCashPolicy`) writes the WHOLE object returned by resolvePolicy.
// So any key Python defines but TypeScript does not know about is silently
// DELETED the next time the owner touches the Cash reserve panel — a data-loss
// bug with no error and no log, which is why it is pinned here.
//
// The collapsed panel's header is pinned too: it is all most owners will ever
// see of a setting that decides how their agents split the money.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_cash_policy_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { DEFAULTS, MAX_RESERVE_PCT, resolvePolicy, describeCashPolicy } =
  await import(join(here, "..", "web", "lib", "cash-policy.ts"));

const HEADER_CASES = {
  defaults: { raw: {}, nav: 1_053_760 },
  raised: { raw: { reserve_pct: 3 }, nav: 1_053_760 },
  zero: { raw: { reserve_pct: 0 }, nav: 1_053_760 },
  // No mark-to-market yet (a brand-new portfolio): the percent still reads.
  no_nav: { raw: { reserve_pct: 3 }, nav: 0 },
};

process.stdout.write(
  JSON.stringify({
    defaults: DEFAULTS,
    max_reserve_pct: MAX_RESERVE_PCT,
    // Clamping and shape-tolerance must agree with Python exactly.
    resolved: {
      empty: resolvePolicy({}),
      null: resolvePolicy(null),
      array: resolvePolicy([1, 2]),
      over_max: resolvePolicy({ reserve_pct: 999 }),
      negative: resolvePolicy({ reserve_pct: -5 }),
      string: resolvePolicy({ reserve_pct: "3" }),
      nan: resolvePolicy({ reserve_pct: Number.NaN }),
      ok: resolvePolicy({ reserve_pct: 3.5 }),
    },
    headers: Object.fromEntries(
      Object.entries(HEADER_CASES).map(([name, c]) => [
        name,
        describeCashPolicy(resolvePolicy(c.raw), c.nav),
      ]),
    ),
  }),
);
