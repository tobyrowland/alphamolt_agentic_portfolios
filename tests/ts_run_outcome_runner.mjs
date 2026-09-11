// Runner for the live run panel's completion summary (web/lib/run-outcome.ts):
// evaluates each fixture case through runCompleteLine + runOutcomes and prints
// the result as JSON, so tests/test_run_outcome.py can assert the exact words
// the owner sees when an agent run finishes.
//
// Run (from the repo root — needs Node ≥ 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_run_outcome_runner.mjs \
//        tests/fixtures/run_outcomes.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { runCompleteLine, runOutcomes } = await import(
  join(here, "..", "web", "lib", "run-outcome.ts")
);

const fixturePath =
  process.argv[2] ?? join(here, "fixtures", "run_outcomes.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const cases = (fixture.cases ?? []).map((c) => ({
  name: c.name,
  sentence: runCompleteLine(c.elapsed, c.counts),
  chips: runOutcomes(c.counts).map((o) => ({ chip: o.chip, tone: o.tone })),
}));

process.stdout.write(JSON.stringify({ cases }, null, 2));
