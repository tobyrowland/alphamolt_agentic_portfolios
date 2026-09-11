// Runner for the live console's positions core (web/lib/live-positions.ts).
//
// The numbers below are the real Scrappy Fightback! sleeve on 2026-08-27, the
// day the owner asked "what are these small rump shareholdings doing in the
// live account?" — three names the mirror had never touched, for two entirely
// different reasons that no surface distinguished.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_live_positions_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  MIRROR_THRESHOLD,
  MIN_ORDER_USD,
  targetWeights,
  sleevePositions,
  positionsSummary,
} = await import(join(here, "..", "web", "lib", "live-positions.ts"));

// Scrappy Fightback! (paper, portfolio-2): $1,050,887.56 of holdings on
// $467.20 of cash. Only the names that matter to the question are itemised;
// OTHERS stands for the fourteen positions at 5.7–8.3% that the mirror had
// just rebalanced, so the weights below are the real ones.
const PAPER_CASH = 467.2;
const PAPER = [
  { ticker: "TREX", marketValue: 29634.02 },   // 2.82%
  { ticker: "TRU", marketValue: 29739.04 },    // 2.83%
  { ticker: "OTHERS", marketValue: 991514.5 },
];

// The live sleeve: $39,071.89 of holdings + $419.15 allowance = $39,491.04.
const EQUITY = 39491.04;
const HOLDINGS = [
  { ticker: "TREX", quantity: 16.6224, price: 46.68 },  // $776
  { ticker: "TRU", quantity: 9.2143, price: 84.55 },    // $779
  { ticker: "KRMN", quantity: 2.149, price: 48.3 },     // $104, off book
  { ticker: "OTHERS", quantity: 1, price: 37212.9 },
];

const targets = targetWeights(PAPER, PAPER_CASH);
const rows = sleevePositions(HOLDINGS, EQUITY, targets);
const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));

// A LARGE inherited name — the shape the in-kind move actually produced
// (migration 084 moved $17,451.64 of records across, not $104). It is off the
// paper book like KRMN, but far past the 1% band, so the next mirror run sells
// it: it is pending, not stranded, and must not be reported as needing a human.
const withBigOrphan = sleevePositions(
  [...HOLDINGS, { ticker: "BIGORPHAN", quantity: 100, price: 52.7 }],
  EQUITY + 5270,
  targets,
);

// A sleeve that has never held a name its book wants: the pending-buy case.
const pendingRows = sleevePositions(
  [{ ticker: "OTHERS", quantity: 1, price: 37212.9 }],
  EQUITY,
  targets,
);

// A paper book sitting on cash must not target 100% invested.
const cashHeavy = targetWeights([{ ticker: "AAA", marketValue: 800 }], 200);

process.stdout.write(
  JSON.stringify({
    constants: { threshold: MIRROR_THRESHOLD, minOrderUsd: MIN_ORDER_USD },
    rows: byTicker,
    summary: positionsSummary(rows),
    pendingBuy: pendingRows.find((r) => r.ticker === "TREX"),
    cashHeavyTarget: cashHeavy.get("AAA"),
    bigOrphan: withBigOrphan.find((r) => r.ticker === "BIGORPHAN"),
    bigOrphanSummary: positionsSummary(withBigOrphan),
    // Nothing held, nothing wanted — never a row.
    emptyRows: sleevePositions([], EQUITY, new Map()),
  }),
);
