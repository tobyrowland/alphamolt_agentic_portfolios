// Runner for the live account's hub state (web/lib/live-activity.ts): evaluates
// each fixture case through buildHubState (plus the schedule/time helpers) and
// prints the results as JSON, so tests/test_live_hub.py can assert the exact
// sentences the hub shows.
//
// Run (from the repo root — needs Node ≥ 22.6 for type stripping):
//   node --experimental-strip-types tests/ts_live_hub_runner.mjs \
//        tests/fixtures/live_hub_states.json
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const {
  buildHubState,
  nextScheduledRun,
  formatRunTime,
  definitelyOutsideTradingHours,
  relativeTime,
} = await import(join(here, "..", "web", "lib", "live-activity.ts"));

const fixturePath =
  process.argv[2] ?? join(here, "fixtures", "live_hub_states.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const helpers = (fixture.helpers ?? []).map((c) => {
  const now = new Date(c.now);
  let actual;
  if (c.fn === "nextScheduledRun") actual = formatRunTime(nextScheduledRun(now));
  else if (c.fn === "definitelyOutsideTradingHours")
    actual = definitelyOutsideTradingHours(now);
  else if (c.fn === "relativeTime") actual = relativeTime(c.arg, now);
  else actual = `unknown helper: ${c.fn}`;
  return { name: c.name, actual };
});

const states = (fixture.states ?? []).map((c) => {
  const state = buildHubState({
    sleeves: c.input.sleeves,
    ledger: c.input.ledger,
    runs: c.input.runs,
    fills: c.input.fills,
    unallocated: c.input.unallocated,
    brokerCash: c.input.brokerCash,
    nowMs: Date.parse(c.input.now),
  });
  return {
    name: c.name,
    actual: {
      headline: state.headline,
      tone: state.tone,
      lines: state.lines.map((l) => ({
        id: l.id,
        tone: l.tone,
        text: l.text,
        ...(l.short ? { short: l.short } : {}),
        ...(l.offerSync ? { offerSync: true } : {}),
      })),
      recentCount: state.recent.length,
      nextRunLabel: state.nextRunLabel,
    },
  };
});

console.log(JSON.stringify({ helpers, states }, null, 2));
