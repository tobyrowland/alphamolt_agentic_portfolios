// Cross-language parity harness (redesign brief §7 / §10): the TS scorer
// (score.ts) and the Python scorer (screen.py) must return identical final_pct
// for the same matview snapshot + lens stats. Run from web/:  node parity_check.mjs
// It prints the TS result as JSON; compare_parity.py runs the SAME fixtures
// through screen.py and asserts equality.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { scoreScreen } = await jiti.import("./lib/screen/score.ts");

import { readFileSync } from "node:fs";
const { rows, config, stats } = JSON.parse(readFileSync("parity_fixture.json", "utf8"));

// score.ts ScreenFacts expects the full row shape; the fixture already provides
// every field. scoreScreen(facts, config, total, stats).
const res = scoreScreen(rows, config, rows.length, stats);
const out = res.rows.map((r) => ({
  ticker: r.ticker,
  final_pct: r.final_pct,
  base_pct: r.base_pct,
  rank: r.rank,
  adj_z: Math.round(r.adj_z * 1e6) / 1e6,
  base_z: Math.round(r.base_z * 1e6) / 1e6,
}));
process.stdout.write(JSON.stringify(out));
