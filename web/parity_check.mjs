// Cross-language parity harness (redesign brief §7 / §10): the TS scorer
// (score.ts) and the Python scorer (screen.py) must return identical final_pct
// for the same matview snapshot + lens stats. Run from web/:  node parity_check.mjs
// It prints the TS result as JSON; compare_parity.py runs the SAME fixtures
// through screen.py and asserts equality.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { scoreScreen } = await jiti.import("./lib/screen/score.ts");

import { readFileSync } from "node:fs";
const { rows, config } = JSON.parse(readFileSync("parity_fixture.json", "utf8"));

// score.ts ScreenFacts expects the full row shape; the fixture provides it.
// The percentile base needs no stats — scoreScreen(facts, config, total).
const res = scoreScreen(rows, config, rows.length);
const out = res.rows.map((r) => ({
  ticker: r.ticker,
  final_pct: r.final_pct,
  base_pct: r.base_pct,
  rank: r.rank,
  quality_pct: r.quality_pct,
  value_pct: r.value_pct,
  momentum_pct: r.momentum_pct,
  adj_z: Math.round(r.adj_z * 1e6) / 1e6,
  base_z: Math.round(r.base_z * 1e6) / 1e6,
  firing_breaks: r.firing_breaks,
}));
process.stdout.write(JSON.stringify(out));
