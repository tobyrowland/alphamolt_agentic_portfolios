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
import "./ts_web_alias_hook.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "web", "lib");
const {
  showsUniverse,
  sizeLine,
  draftLine,
  selfSourcedLine,
  rankingLine,
  NO_FILTERS_LINE,
} = await import(join(lib, "portfolio-universe.ts"));
// screen/config.ts needs the `@/` alias (handled by the hook above) AND zod,
// which the CI test job does not install — it runs pytest + ruff only, no npm.
// So import it optionally: the pure-module cases below still run there, and
// the label cases report null and skip rather than taking the file down.
let cfgMod = null;
try {
  cfgMod = await import(join(lib, "screen", "config.ts"));
} catch {
  cfgMod = null;
}
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
  modified: false,
  filters: ["% off 52-week high ≥ 40", "P/S vs own median ≤ 0"],
  weights: { quality: 15, value: 20, momentum: 5, inflection: 60 },
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

// The real "Quality Growth" configs on the live books (2026-09-11). Three of
// the four had deleted every filter but `P/S ≤ 15` while keeping the preset
// id, which is what made the shipped strip read "Quality Growth · 2,653 of
// 3,030 names pass".
function labelCases() {
  if (!cfgMod) return null;
  const { PRESETS, isHousePreset, screenConfigSchema, screenFilterLabel } = cfgMod;
  const untouched = screenConfigSchema.parse({
    ...PRESETS["quality-growth"].config,
    preset: "quality-growth",
  });
  const drifted = screenConfigSchema.parse({
    preset: "quality-growth",
    filters: [{ op: "<=", field: "ps", value: 15 }],
    weights: { value: 25, quality: 60, momentum: 15 },
    topN: 40,
  });
  return {
    untouchedIsPreset: isHousePreset(untouched),
    driftedIsPreset: isHousePreset(drifted),
    untouchedFilters: untouched.filters.map(screenFilterLabel),
    driftedFilters: drifted.filters.map(screenFilterLabel),
  };
}

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
  ranking: {
    turnaround: rankingLine(base),
    // Zero-weight lenses are omitted, and the order is heaviest-first.
    qualityGrowth: rankingLine({
      ...base,
      weights: { quality: 60, value: 25, momentum: 15, inflection: 0 },
    }),
    allZero: rankingLine({
      ...base,
      weights: { quality: 0, value: 0, momentum: 0, inflection: 0 },
    }),
  },
  // null when zod is unavailable (see the optional import above).
  labels: labelCases(),
  noFiltersLine: NO_FILTERS_LINE,
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
