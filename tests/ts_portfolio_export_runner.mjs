// Runner for the portfolio review-pack builder (web/lib/portfolio-export.ts).
//
// The export exists so an owner can hand their book to a DIFFERENT model and
// get a useful critique. That makes some omissions worse than others: a pack
// missing the closed positions invites praise for the survivors, and one that
// calls day-old closes "current" gets reasoned about as if it were live.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_portfolio_export_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { buildPortfolioExport, exportFilename, markFiring } = await import(
  join(here, "..", "web", "lib", "portfolio-export.ts")
);

// Modelled on the real Scrappy Fightback book.
const DATA = {
  name: "Scrappy Fightback!",
  slug: "portfolio-2",
  mandate: "Buy high-quality businesses that have fallen hard and are fighting back.",
  isPublic: true,
  generatedAt: "2026-09-02T13:00:00Z",
  pricedAsOf: "2026-09-01",
  totalValue: 1037823.93,
  cash: 467.2,
  startingCash: 1000000,
  returnPct: 3.78,
  inceptionDate: "2026-07-20",
  holdings: [
    {
      ticker: "PODD",
      name: "Insulet",
      shares: 425,
      avgCost: 162.6264,
      price: 148.38,
      marketValue: 63061.5,
      weightPct: 6.08,
      unrealisedUsd: -6054.72,
      unrealisedPct: -8.76,
      firstBoughtAt: "2026-07-20",
      openedBy: "buyer-gemini",
      thesis: {
        openedAt: "2026-08-26",
        text: "Insulet's tubeless Omnipod delivers durable ~29% TTM growth at 3.25x sales.",
        extendSignals: [
          // No `firing` key at all — not checked, which must render clean.
          { field: "rev_growth_ttm_pct", op: ">", value: 30, description: "Growth reaccelerates" },
        ],
        breakSignals: [
          { field: "gross_margin_pct", op: "<", value: 65, description: "Margin breaks", firing: false },
          { field: "price_pct_of_52w_high", op: "<", value: 40, description: "New lows", firing: null },
          { field: "rev_growth_ttm_pct", op: "<", value: 32, description: "Growth stalls", firing: true },
        ],
      },
    },
  ],
  trades: [
    {
      executedAt: "2026-08-26", ticker: "PODD", side: "buy", quantity: 29,
      price: 143.05, grossUsd: 4148.45, agent: "double-down",
      rationale: "Double-down 5/5 — added to PODD (held 5.4%).",
    },
    {
      executedAt: "2026-08-11", ticker: "ADMA", side: "sell", quantity: 100,
      price: 12.5, grossUsd: 1250, agent: "portfolio-reviewer",
      rationale: "Thesis broken.", realisedUsd: -430.5,
    },
  ],
  closed: [{ ticker: "ADMA", realisedUsd: -430.5, lastSoldAt: "2026-08-11" }],
  // The real Scrappy Fightback team: a screen buyer, a self-sourced buyer that
  // never sees the screen, and a reviewer — on three different cadences.
  team: [
    {
      name: "Buyer · Gemini", role: "buyer", brief: "Find fallen leaders.",
      kind: "screen-buyer", cadenceHours: 168, convictionGate: 5,
      targetPct: 4, minPct: 2,
    },
    {
      name: "Portfolio Review Agent", role: "reviewer", brief: null,
      kind: "reviewer", cadenceHours: 168, convictionGate: null,
      sellThreshold: 4,
    },
    {
      name: "Double-Down Buyer", role: "buyer", brief: "Press the winners.",
      kind: "self-sourced-buyer",
      sourcedFrom: "the portfolio's own current holdings",
      cadenceHours: 24, convictionGate: 5, addPct: 1.5, maxPct: 9,
    },
  ],
  universe: {
    presetLabel: "Turnaround",
    brief: "Quality businesses well off their highs with evidence of inflection.",
    filters: [
      "Drawdown from 52w high ≥ 30%",
      "Gross margin ≥ 40%",
      "FCF margin improving streak ≥ 2q  OR  Rev growth accelerating ≥ 2q",
    ],
    weights: { quality: 15, value: 20, momentum: 5, inflection: 60 },
    topN: 40,
    aiBudget: 1.2,
    hideRejected: true,
  },
  sellDiscipline: {
    grace_period_days: 30,
    require_fired_break_signal: true,
    relative_fields_change_only: true,
  },
  cashReserve: { reserve_pct: 2 },
};

const doc = buildPortfolioExport(DATA);

// A book with nothing sold and nothing held — the empty-state shape.
const empty = buildPortfolioExport({
  ...DATA,
  holdings: [], trades: [], closed: [], team: [], mandate: null,
  sellDiscipline: null, cashReserve: null, pricedAsOf: null, universe: null,
});

// A screen with the Inflection lens switched off — the pre-074 default.
const zeroWeight = buildPortfolioExport({
  ...DATA,
  universe: { ...DATA.universe, weights: { quality: 45, value: 25, momentum: 30, inflection: 0 } },
});

// The tri-state, against real facts. gross_margin_pct is known; ps_now is
// known; price_pct_of_52w_high has no column behind it; change_pct_lt is not
// checked here at all.
const marked = markFiring(
  [
    { field: "gross_margin_pct", op: "<", value: 65 },
    { field: "gross_margin_pct", op: "<", value: 80 },
    { field: "price_pct_of_52w_high", op: "<", value: 40 },
    { field: "gross_margin_pct", op: "change_pct_lt", value: -3 },
  ],
  { gross_margin_pct: 71.1, ps_now: 3.25 },
);

process.stdout.write(
  JSON.stringify({
    doc,
    marked,
    empty,
    zeroWeight,
    filename: exportFilename("portfolio-2", "2026-09-02T13:00:00Z"),
  }),
);
