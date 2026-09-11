// Runner for the public Universe summary (web/lib/portfolio-universe.ts) and
// the strategy classification it decides with (web/lib/agents/strategy-kind.ts).
//
// The cases are the two books that make the summary hard to write honestly:
// Scrappy Fightback!, which runs a screen buyer AND the Double-Down Buyer (a
// self-sourced buyer that never sees the screen), and a hypothetical
// Pelosi-only book, whose screen_config exists — every book gets one at
// creation — while nothing in the team ever reads it.
//
// Run (from the repo root — needs Node >= 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_portfolio_universe_runner.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "web", "lib");
const { showsUniverse, sizeLine, draftLine, selfSourcedLine } = await import(
  join(lib, "portfolio-universe.ts")
);
const {
  SELF_SOURCED_BUYERS,
  SCREEN_BUYER_STRATEGIES,
  REVIEWER_STRATEGIES,
  strategyKind,
  draftsFromScreen,
} = await import(join(lib, "agents", "strategy-kind.ts"));

const base = {
  presetLabel: "Turnaround",
  isCustom: false,
  topN: 20,
  matchCount: 63,
  universeCount: 3142,
  asOf: "2026-09-10",
  screenBuyers: [],
  selfSourced: [],
};

// Scrappy Fightback!: one screen buyer plus the self-sourced Double-Down.
const mixed = {
  ...base,
  screenBuyers: [{ name: "Buyer · Gemini" }],
  selfSourced: [
    { name: "Double-Down Buyer", sourcedFrom: "the portfolio's own current holdings" },
  ],
};

// A book whose only buyer never reads the screen.
const pelosiOnly = {
  ...base,
  screenBuyers: [],
  selfSourced: [
    { name: "Pelosi Tracker", sourcedFrom: "a member of Congress's disclosed trades" },
  ],
};

const threeBuyers = {
  ...base,
  screenBuyers: [
    { name: "Buyer · Gemini" },
    { name: "Buyer · Claude" },
    { name: "Buyer · GPT-5" },
  ],
};

const out = {
  shows: {
    mixed: showsUniverse(mixed),
    pelosiOnly: showsUniverse(pelosiOnly),
    nullSummary: showsUniverse(null),
  },
  size: {
    full: sizeLine(mixed),
    noTotal: sizeLine({ ...mixed, universeCount: null }),
    singular: sizeLine({ ...mixed, matchCount: 1, universeCount: null }),
    unavailable: sizeLine({ ...mixed, matchCount: null }),
  },
  draft: {
    one: draftLine(mixed),
    two: draftLine({
      ...base,
      screenBuyers: [{ name: "Buyer · Gemini" }, { name: "Buyer · Claude" }],
    }),
    three: draftLine(threeBuyers),
  },
  selfSourced: {
    none: selfSourcedLine({ ...base, screenBuyers: [{ name: "Buyer · Gemini" }] }),
    one: selfSourcedLine(mixed),
    two: selfSourcedLine({
      ...mixed,
      selfSourced: [
        { name: "Double-Down Buyer", sourcedFrom: "the portfolio's own current holdings" },
        { name: "Pelosi Tracker", sourcedFrom: "a member of Congress's disclosed trades" },
      ],
    }),
  },
  kinds: {
    selfSourced: Object.keys(SELF_SOURCED_BUYERS).sort(),
    screenBuyers: [...SCREEN_BUYER_STRATEGIES].sort(),
    reviewers: [...REVIEWER_STRATEGIES].sort(),
    doubleDown: strategyKind("double_down"),
    pelosi: strategyKind("pelosi_mirror"),
    llmBuyer: strategyKind("llm_watchlist_buyer"),
    reviewer: strategyKind("portfolio_reviewer"),
    unknown: strategyKind("something_new"),
    nullStrategy: strategyKind(null),
    draftsDoubleDown: draftsFromScreen("double_down"),
    draftsLlmBuyer: draftsFromScreen("llm_watchlist_buyer"),
  },
};

process.stdout.write(JSON.stringify(out, null, 2));
