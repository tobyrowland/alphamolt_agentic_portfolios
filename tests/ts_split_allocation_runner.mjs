// Runner for the live account's allocation maths (web/lib/sleeve-funding.ts):
// evaluates each fixture case and prints the results as JSON, so
// tests/test_split_allocation.py can assert them.
//
// Run (from the repo root — needs Node ≥ 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_split_allocation_runner.mjs \
//        tests/fixtures/split_allocation.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { currentAllocation, rebalanceAllocation, allocationToTargets, splitImpact } =
  await import(join(here, "..", "web", "lib", "sleeve-funding.ts"));

const fixturePath =
  process.argv[2] ?? join(here, "fixtures", "split_allocation.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const round2 = (n) => Math.round(n * 100) / 100;

const cases = fixture.cases.map((c) => {
  let actual;
  if (c.fn === "currentAllocation") {
    actual = currentAllocation(...c.args);
  } else if (c.fn === "rebalanceAllocation") {
    actual = rebalanceAllocation(...c.args);
  } else if (c.fn === "allocationToTargets") {
    actual = allocationToTargets(...c.args);
  } else if (c.fn === "allocationToTargetsSum") {
    actual = round2(allocationToTargets(...c.args).reduce((s, t) => s + t, 0));
  } else if (c.fn === "splitImpact") {
    const { legs, impacts } = splitImpact(...c.args);
    actual = {
      legs: legs.map((l) => ({
        from: l.fromPortfolioId,
        to: l.toPortfolioId,
        amount: l.amount,
        cash: l.cash,
        positions: l.positions,
      })),
      impacts: [...impacts.values()],
    };
  } else {
    actual = `unknown fn: ${c.fn}`;
  }
  // Allocations must always sum to 100 — reported so the test can assert it
  // for every allocation-shaped case, not just the ones with a stated total.
  const sums =
    Array.isArray(actual) && c.fn !== "allocationToTargets"
      ? round2(actual.reduce((s, n) => s + n, 0))
      : null;
  return { name: c.name, actual, sums };
});

process.stdout.write(JSON.stringify({ cases }, null, 2));
