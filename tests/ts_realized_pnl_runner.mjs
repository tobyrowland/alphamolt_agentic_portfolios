// Runner for the realized-P&L reconstruction (web/lib/realized-pnl.ts):
// evaluates realizedPnlByTrade over each fixture case and prints the resulting
// sell-id -> {usd, pct} map as JSON, so tests/test_realized_pnl.py can assert
// against the expected values.
//
// Run (from the repo root — needs Node ≥ 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_realized_pnl_runner.mjs \
//        tests/fixtures/realized_pnl_cases.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { realizedPnlByTrade } = await import(
  join(here, "..", "web", "lib", "realized-pnl.ts")
);

const fixturePath =
  process.argv[2] ?? join(here, "fixtures", "realized_pnl_cases.json");
const cases = JSON.parse(readFileSync(fixturePath, "utf8"));

const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);

const results = cases.map((c) => {
  const map = realizedPnlByTrade(c.trades);
  const actual = {};
  for (const [id, pnl] of map) {
    actual[id] = { usd: round(pnl.usd), pct: round(pnl.pct) };
  }
  return { name: c.name, actual };
});
process.stdout.write(JSON.stringify(results));
