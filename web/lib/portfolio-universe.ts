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
 * DELIBERATELY NOT THE RECIPE. Label, size and the draft depth describe the
 * pond; the filters and weights that define it stay owner-only, where the
 * export pack already keeps them (a public leaderboard entry is not consent
 * to publishing a competitor's selection recipe).
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

export interface UniverseSummary {
  /** House preset label, or the preset id, or "Custom screen". */
  presetLabel: string;
  isCustom: boolean;
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
