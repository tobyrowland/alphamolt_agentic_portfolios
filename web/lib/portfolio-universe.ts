/**
 * The public "Universe" summary — what a book's buyers are allowed to pick
 * from, said in one line on the portfolio page the leaderboard links to.
 *
 * A leaderboard row answers "how did it do". The question it provokes is
 * "out of what?" — a swarm ranked on 30-day return against a 60-name washed-
 * out turnaround screen is doing something different from one fishing the
 * whole liquid US universe, and nothing public said which. This module is the
 * summary; the owner-only Universe tab remains the place the screen is read
 * and edited in full.
 *
 * THE WHOLE SELECTION RULE, not just its size. The first version showed only
 * a label and a count, and the count turned out to say almost nothing: the
 * house "Quality Growth" preset filters on four things, but several books had
 * deleted three of them, so 2,653 of 3,030 names passed and the strip read as
 * a big impressive number describing no constraint at all. What narrows a book
 * is the filters plus the ranking weights, so both are stated. The owner-only
 * Universe tab remains the place the screen is EDITED; this is the read-only
 * public account of it.
 *
 * The filters arrive pre-rendered by `screenFilterLabel` — the same function
 * behind the Universe tab's chips and the review pack — so no surface can
 * describe one screen in two dialects.
 *
 * Pure — no DB, no zod, no imports at all, so the copy decisions below are
 * pinned by `tests/test_portfolio_universe.py` through the real module.
 * `portfolio-universe-query.ts` is the server side that fills it in.
 */

export interface UniverseBuyer {
  /** The agent's display name, as the roster shows it. */
  name: string;
  /** Self-sourced only: the feed it reads instead of the screen. */
  sourcedFrom?: string;
}

/** Lens weights, as the screener's four-way blend stores them. */
export interface UniverseWeights {
  quality: number;
  value: number;
  momentum: number;
  inflection: number;
}

export interface UniverseSummary {
  /** House preset label, or "Custom screen". */
  presetLabel: string;
  isCustom: boolean;
  /**
   * The config started from a house preset but no longer matches it.
   *
   * `portfolios.screen_config` keeps the preset ID after the owner edits the
   * filters, so the stored ID alone is not a description: three of the four
   * live "Quality Growth" books had deleted every filter but `P/S ≤ 15` and
   * still carried the name. Rendering the name unqualified next to one chip
   * states a screen that does not exist.
   */
  modified: boolean;
  /** Filter chips, pre-rendered by `screenFilterLabel`. Empty = no filters. */
  filters: string[];
  /** The blend the survivors are ranked by. */
  weights: UniverseWeights;
  /** How many names the buyers see: the screen's ranked top N. */
  topN: number;
  /** Names passing the filters today; null when the count was unavailable. */
  matchCount: number | null;
  /** The whole liquid US (Tier 1) universe the filters were applied to. */
  universeCount: number | null;
  /** Freshness of the facts the count was computed over (YYYY-MM-DD). */
  asOf: string | null;
  /** Hired agents that draft from this screen. */
  screenBuyers: UniverseBuyer[];
  /** Hired buyers that never see it — each with what it reads instead. */
  selfSourced: UniverseBuyer[];
}

/**
 * Whether the summary is true of this book at all.
 *
 * `portfolios.screen_config` is seeded at creation, so almost every book HAS
 * a screen; that is not the same as buying from one. A book whose only buyer
 * is the Pelosi Tracker would be described by its screen and contradicted by
 * every position in it, so with no screen-drafting buyer hired the card does
 * not render. Fail-closed: a roster read that failed comes through as an
 * empty team and shows nothing rather than a claim.
 */
export function showsUniverse(s: UniverseSummary | null): s is UniverseSummary {
  return !!s && s.screenBuyers.length > 0;
}

/**
 * "63 of 3,142 names pass today" — the pond, before ranking.
 *
 * Both halves matter: the count alone reads as a lot or a little depending on
 * a denominator the reader does not have, and "63" out of the whole liquid US
 * universe is the fact that makes a narrow screen legible as narrow.
 */
export function sizeLine(s: UniverseSummary): string {
  if (s.matchCount == null) return "size unavailable";
  const one = s.matchCount === 1;
  const n = s.matchCount.toLocaleString("en-US");
  const noun = `name${one ? "" : "s"}`;
  const verb = one ? "passes" : "pass";
  if (s.universeCount == null) return `${n} ${noun} ${verb} today`;
  return `${n} of ${s.universeCount.toLocaleString("en-US")} ${noun} ${verb} today`;
}

/**
 * The lens blend, zero-weight lenses omitted.
 *
 * This is half the answer to "what does this book select for", and on a
 * barely-filtered screen it is nearly all of it: when 88% of the universe
 * passes the filters, what the book actually does is rank and take the top N.
 */
export function rankingLine(s: UniverseSummary): string {
  const parts = (["quality", "value", "momentum", "inflection"] as const)
    .filter((k) => s.weights[k] > 0)
    .sort((a, b) => s.weights[b] - s.weights[a])
    .map((k) => `${k} ${s.weights[k]}`);
  // Every lens at zero is a degenerate config the schema still permits; say
  // what actually happens (the blend is flat) rather than an empty sentence.
  if (parts.length === 0) return "Ranked on an even blend of every lens.";
  return `Ranked on ${parts.join(" · ")}.`;
}

/** What to say where the chips go when a screen constrains nothing. */
export const NO_FILTERS_LINE =
  "No filters — the whole liquid US universe is eligible before ranking.";

/** "The top 20 are offered to Buyer · Gemini each run." */
export function draftLine(s: UniverseSummary): string {
  const names = s.screenBuyers.map((b) => b.name);
  return `The top ${s.topN} ranked names are offered to ${joinNames(names)} each run.`;
}

/**
 * The correction a screen summary needs when the book also runs a buyer that
 * never reads it. Without this line the card silently claims every position
 * came through the screen.
 */
export function selfSourcedLine(s: UniverseSummary): string | null {
  if (s.selfSourced.length === 0) return null;
  const parts = s.selfSourced.map((b) =>
    b.sourcedFrom ? `${b.name} (${b.sourcedFrom})` : b.name,
  );
  const buys = s.selfSourced.length === 1 ? "buys" : "buy";
  return `${joinNames(parts)} ${buys} outside this screen.`;
}

function joinNames(names: string[]): string {
  if (names.length === 0) return "the buyers";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
