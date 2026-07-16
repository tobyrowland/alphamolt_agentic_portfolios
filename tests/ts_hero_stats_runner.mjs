// Runner for the hero stat-strip logic: evaluates web/lib/hero-stats.ts over
// the shared fixture and prints the results as JSON, so
// tests/test_hero_stats.py can assert against the expected values.
//
// Run (from the repo root — needs Node ≥ 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_hero_stats_runner.mjs \
//        tests/fixtures/hero_stats_cases.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const heroStats = await import(join(here, "..", "web", "lib", "hero-stats.ts"));

const fixturePath =
  process.argv[2] ?? join(here, "fixtures", "hero_stats_cases.json");
const cases = JSON.parse(readFileSync(fixturePath, "utf8"));

const results = cases.map((c) => {
  const fn = heroStats[c.fn];
  if (typeof fn !== "function") {
    return { name: c.name, actual: `<unknown fn: ${c.fn}>` };
  }
  let actual;
  try {
    actual = fn(...c.args);
  } catch (err) {
    actual = `<threw: ${err.message}>`;
  }
  // JSON has no undefined — normalise so the Python side compares cleanly.
  return { name: c.name, actual: actual === undefined ? null : actual };
});
process.stdout.write(JSON.stringify(results));
