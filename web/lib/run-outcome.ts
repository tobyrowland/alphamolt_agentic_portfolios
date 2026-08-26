/**
 * What a finished agent run actually did — the counts the live run panel
 * reports (web/components/portfolio/build-run-live.tsx).
 *
 * WHY THIS IS A MODULE AND NOT THREE TERNARIES IN THE COMPONENT.
 * The panel is generic across the whole agent library, but the summary it
 * shipped with was buy-agent-shaped: it always printed a buy count and a pass
 * count, and mentioned sells only when there were some. So a Portfolio Review
 * Agent — an agent that can ONLY sell — finished a clean run and reported
 * "0 buys, 0 passes": two numbers describing work it cannot do, and silence on
 * the one outcome it can produce. The same asymmetry made the chip row read
 * "0 bought · 1 sold · 0 passed" after a real sale.
 *
 * The fix is not to teach the panel which agent ran (a run's event feed is not
 * guaranteed to be single-agent, and the dispatch doesn't carry the action).
 * It is to report only what HAPPENED. An outcome that did not occur is not
 * news, whichever agent was running; and when nothing occurred at all, that is
 * a real result with its own plain words rather than a row of zeroes.
 */

export interface RunCounts {
  buys: number;
  sells: number;
  passes: number;
}

export type OutcomeTone = "positive" | "negative" | "neutral";

export interface RunOutcome {
  key: "buys" | "sells" | "passes";
  count: number;
  /** For the sentence: "2 buys" / "1 sell". */
  noun: string;
  /** For the chip row: "2 bought" / "1 sold". */
  chip: string;
  tone: OutcomeTone;
}

const SHAPES: {
  key: RunOutcome["key"];
  one: string;
  many: string;
  chip: string;
  tone: OutcomeTone;
}[] = [
  { key: "buys", one: "buy", many: "buys", chip: "bought", tone: "positive" },
  { key: "sells", one: "sell", many: "sells", chip: "sold", tone: "negative" },
  { key: "passes", one: "pass", many: "passes", chip: "passed", tone: "neutral" },
];

/** The outcomes that actually happened, in buy → sell → pass order. */
export function runOutcomes(counts: RunCounts): RunOutcome[] {
  return SHAPES.filter((s) => (counts[s.key] ?? 0) > 0).map((s) => {
    const count = counts[s.key];
    return {
      key: s.key,
      count,
      noun: `${count} ${count === 1 ? s.one : s.many}`,
      chip: `${count} ${s.chip}`,
      tone: s.tone,
    };
  });
}

/**
 * The panel's completion sentence. `elapsed` is pre-formatted ("1:53").
 *
 * A run where nothing happened says so in words — the agent's own journal line
 * underneath supplies the reason ("reviewed 24 positions · no positions met the
 * sell threshold"), which is the part worth reading.
 */
export function runCompleteLine(elapsed: string, counts: RunCounts): string {
  const outcomes = runOutcomes(counts);
  const what = outcomes.length
    ? outcomes.map((o) => o.noun).join(", ")
    : "no changes";
  return `Run complete in ${elapsed} — ${what}.`;
}
