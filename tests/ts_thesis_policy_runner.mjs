// Cross-language parity runner for the owner sell discipline.
//
// web/lib/thesis-policy.ts is the twin of thesis_policy.py, and the save action
// (`setPortfolioThesisPolicy`) writes the WHOLE object returned by resolvePolicy.
// So any key Python defines but TypeScript does not know about is silently
// DELETED the next time the owner touches the Sell discipline panel. That is a
// data-loss bug with no error and no log — which is why it is pinned here.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_thesis_policy_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { DEFAULTS, RELATIVE_FIELDS, resolvePolicy, describeSellDiscipline } =
  await import(join(here, "..", "web", "lib", "thesis-policy.ts"));

// The Sell discipline panel is collapsed by default, so this one line is all
// most owners will ever see of the rules governing every sell their team makes.
// It has to be right whether the panel is open or shut.
const HEADER_CASES = {
  defaults: {},
  no_grace: { grace_period_days: 0 },
  both_toggles_off: {
    require_fired_break_signal: false,
    relative_fields_change_only: false,
  },
  longer_grace: { grace_period_days: 45 },
  // Operator-set key only: the owner has changed NOTHING they can see, so the
  // header must not claim they customised it.
  operator_exemption_only: {
    rebuy_cooldown_ignores_sells_before: "2026-08-25T00:00:00Z",
  },
};

process.stdout.write(
  JSON.stringify({
    defaults: DEFAULTS,
    relative_fields: [...RELATIVE_FIELDS],
    // What the collapsed panel header says, per situation.
    headers: Object.fromEntries(
      Object.entries(HEADER_CASES).map(([name, raw]) => [
        name,
        describeSellDiscipline(resolvePolicy(raw)),
      ]),
    ),
    // A stored policy carrying the operator-set key, round-tripped through the
    // exact call the save action makes.
    round_trip: resolvePolicy({
      grace_period_days: 45,
      require_fired_break_signal: false,
      relative_fields_change_only: true,
      rebuy_cooldown_ignores_sells_before: "2026-08-25T00:00:00Z",
    }),
  }),
);
