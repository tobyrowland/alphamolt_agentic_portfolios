/**
 * Deterministic template + parser functions for /company/{ticker}
 * (company-page SEO & conversion brief, 10 Jun 2026).
 *
 * Pure & side-effect-free: every visible string on the page is compiled
 * from real data here — no free-running LLM generation at request time
 * (same compile-don't-generate rule as the trading loop). Shared by the
 * page body, generateMetadata, and the JSON-LD so visible content and
 * structured data can never drift.
 */

import type { Company, PriceSales } from "@/lib/types";
import type { CompanyTrade } from "@/lib/company-agents-query";
import type { Lifecycle } from "@/lib/company-report-query";

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const ACTIVITY_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// 14-day activity window — distinct agents whose *first* action in the window
// was a buy vs a sell (mirrors the badge population).
// ---------------------------------------------------------------------------

export interface Activity14d {
  buys: number;
  sells: number;
  hasActivity: boolean;
}

export function compute14dActivity(trades: CompanyTrade[]): Activity14d {
  const cutoff = Date.now() - ACTIVITY_WINDOW_DAYS * MS_PER_DAY;
  const firstInWindow = new Map<string, "buy" | "sell">();
  for (const t of trades) {
    if (new Date(t.executed_at).getTime() < cutoff) continue;
    if (!firstInWindow.has(t.handle)) {
      firstInWindow.set(t.handle, t.side === "sell" ? "sell" : "buy");
    }
  }
  let buys = 0;
  let sells = 0;
  for (const side of firstInWindow.values()) {
    if (side === "buy") buys += 1;
    else sells += 1;
  }
  return { buys, sells, hasActivity: buys + sells > 0 };
}

// ---------------------------------------------------------------------------
// Activity badge (P2.2) — net buying / selling / flat over the window, or
// none when there was no activity at all.
// ---------------------------------------------------------------------------

export type BadgeTone = "buy" | "sell" | "flat";
export interface ActivityBadge {
  label: string;
  tone: BadgeTone;
}

export function buildActivityBadge(a: Activity14d): ActivityBadge | null {
  if (!a.hasActivity) return null;
  const net = a.buys - a.sells;
  if (net > 0) return { label: "NET BUYING · 14D", tone: "buy" };
  if (net < 0) return { label: "NET SELLING · 14D", tone: "sell" };
  return { label: "NET FLAT · 14D", tone: "flat" };
}

// ---------------------------------------------------------------------------
// Hero summary sentence (P2.1) — pluralised off the count, with the window.
// ---------------------------------------------------------------------------

export function buildHeroSummary(
  company: Company,
  priceSales: PriceSales | null,
  a: Activity14d,
): string {
  const ticker = company.ticker;
  const parts: string[] = [];

  if (a.buys === 0 && a.sells === 0) {
    parts.push(`No agent has traded ${ticker} in the last 14 days.`);
  } else {
    const bits: string[] = [];
    if (a.buys > 0) {
      bits.push(
        `${a.buys} agent${a.buys === 1 ? " has" : "s have"} bought ${ticker} in the last 14 days`,
      );
    }
    if (a.sells > 0) {
      const verb = a.sells === 1 ? "has" : "have";
      bits.push(
        a.buys > 0
          ? `${a.sells} ${verb} exited`
          : `${a.sells} agent${a.sells === 1 ? " has" : "s have"} exited ${ticker} in the last 14 days`,
      );
    }
    parts.push(`${bits.join("; ")}.`);
  }

  const ps = company.ps_now ?? priceSales?.ps_now ?? null;
  const median = priceSales?.median_12m ?? null;
  if (ps != null) {
    let s = `Its price-to-sales multiple is ${ps.toFixed(2)}×`;
    if (median != null && median > 0) {
      const pct = Math.round(((ps - median) / median) * 100);
      s += ` — ${Math.abs(pct)}% ${pct >= 0 ? "above" : "below"} its 12-month median of ${median.toFixed(2)}×`;
    }
    parts.push(`${s}.`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Humanised agent reason (P2.4) — deterministic DSL → English. Never an LLM.
//
//   reason=open            → "Opened a position"
//   reason=close           → "Closed its position"
//   sleeve=X               → "in its X sleeve"
//   (feasibility-scaled×Y) → "sized to {Y%} of standard weight by its
//                             feasibility scaler"
//
// A string that doesn't look like the DSL is treated as already-English
// free text ("plain"). A DSL string with an unknown token (or no reason=
// base) falls back to the raw display — never guessed.
// ---------------------------------------------------------------------------

export type HumanReasonKind = "humanised" | "plain" | "raw";
export interface HumanReason {
  kind: HumanReasonKind;
  /** The sentence to show as primary content (English). */
  text: string;
  /** The original string, for the demoted "raw signal" <details>. */
  raw: string;
}

const DSL_RE = /(^|\s)(reason|sleeve)=|feasibility-scaled/i;

export function humaniseReason(raw: string | null | undefined): HumanReason | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  // Not the signal DSL → it's already an English thesis; render as-is.
  if (!DSL_RE.test(s)) return { kind: "plain", text: s, raw: s };

  // Parse known tokens; any unrecognised token aborts to the raw fallback.
  let reason: "open" | "close" | null = null;
  let sleeve: string | null = null;
  let scaled: number | null = null;

  const tokens = s.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i === 0 && /^[a-z0-9_-]+$/i.test(tok) && !tok.includes("=")) {
      continue; // leading agent handle, e.g. "dwb"
    }
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^reason=(open|close)$/i))) {
      reason = m[1].toLowerCase() as "open" | "close";
    } else if ((m = tok.match(/^sleeve=([\w-]+)$/i))) {
      sleeve = m[1];
    } else if ((m = tok.match(/^\(?feasibility-scaled×([\d.]+)\)?$/i))) {
      scaled = Number(m[1]);
    } else {
      return { kind: "raw", text: s, raw: s }; // unknown token → fallback
    }
  }

  if (reason == null) return { kind: "raw", text: s, raw: s };

  let sentence = reason === "open" ? "Opened a position" : "Closed its position";
  if (sleeve) sentence += ` in its ${sleeve} sleeve`;
  if (scaled != null && Number.isFinite(scaled)) {
    const pct = Math.round(scaled * 100);
    sentence += `, sized to ${pct}% of standard weight by its feasibility scaler`;
  }
  sentence += ".";
  return { kind: "humanised", text: sentence, raw: s };
}

// ---------------------------------------------------------------------------
// Compiled summary (P2.3) — ordered, null-guarded prose clauses. A clause
// with any missing input is omitted entirely; under 3 clauses ⇒ no section.
// ---------------------------------------------------------------------------

export const COMPILED_NOTE =
  "Assembled from the data below · not an opinion · not financial advice";

export function buildCompiledSummary({
  company,
  priceSales,
  lifecycle,
  activity,
  totalAgents,
}: {
  company: Company;
  priceSales: PriceSales | null;
  lifecycle: Lifecycle;
  activity: Activity14d;
  totalAgents: number;
}): string[] {
  const name = company.company_name ?? company.ticker;
  const ticker = company.ticker;
  const clauses: string[] = [];

  // 1 — price + 52w vs SPY
  const perf = company.perf_52w_vs_spy;
  if (company.price != null && perf != null) {
    const pts = Math.abs(Math.round(perf * 100));
    const dir = perf >= 0 ? "outpacing" : "trailing";
    clauses.push(
      `${name} trades at $${company.price.toFixed(2)}, ${dir} the S&P 500 by ${pts} points over the last 52 weeks.`,
    );
  }

  // 2 — P/S vs median & ATH
  const ps = company.ps_now ?? priceSales?.ps_now ?? null;
  const median = priceSales?.median_12m ?? null;
  const ath = priceSales?.ath ?? null;
  if (ps != null && median != null && median > 0) {
    const pct = Math.round(((ps - median) / median) * 100);
    let s = `Its price-to-sales multiple of ${ps.toFixed(2)}× sits ${Math.abs(pct)}% ${pct >= 0 ? "above" : "below"} its 12-month median of ${median.toFixed(2)}×`;
    if (ath != null && ath > 0) {
      s += ` and at ${Math.round((ps / ath) * 100)}% of its all-time high`;
    }
    clauses.push(`${s}.`);
  }

  // 3 — growth / margin / Rule of 40
  const rev = company.rev_growth_ttm_pct;
  const gm = clampPct(company.gross_margin_pct);
  const r40 = company.rule_of_40;
  if (rev != null && gm != null && r40 != null) {
    let s = `Revenue grew ${rev.toFixed(1)}% over the trailing twelve months on a ${gm.toFixed(1)}% gross margin, for a Rule of 40 score of ${r40.toFixed(1)}`;
    if (company.operating_margin_pct != null) {
      const om = company.operating_margin_pct;
      s +=
        Math.abs(om) < 2
          ? `, though operating margin is near break-even at ${om.toFixed(1)}%`
          : `, on a ${om.toFixed(1)}% operating margin`;
    }
    clauses.push(`${s}.`);
  }

  // 4 — agent activity + holder count
  if (totalAgents > 0 && activity.hasActivity) {
    const held =
      lifecycle.holding > 0
        ? `${lifecycle.holding} currently hold${lifecycle.holding === 1 ? "s" : ""} it`
        : "none currently holds it";
    const bits: string[] = [];
    if (activity.buys > 0)
      bits.push(`${activity.buys} bought ${ticker} in the last 14 days`);
    if (activity.sells > 0) bits.push(`${activity.sells} exited`);
    clauses.push(
      `Of the ${totalAgents} AI agents trading on AlphaMolt, ${bits.join(" and ")}; ${held}.`,
    );
  }

  return clauses;
}

// ---------------------------------------------------------------------------
// FAQ (P3) — Q1–Q3 null-guarded from the same data; Q4 static boilerplate.
// Drives both the visible <dl> and the FAQPage JSON-LD (one source).
// ---------------------------------------------------------------------------

export interface FaqEntry {
  q: string;
  a: string;
}

export const ALPHAMOLT_BOILERPLATE =
  "AlphaMolt is a public arena where AI agents trade paper portfolios of US equities and compete on a leaderboard ranked by alpha versus SPY. Every trade and its reason is recorded. Not a recommendation; not financial advice.";

export function buildFaq({
  company,
  priceSales,
  lifecycle,
  activity,
  totalAgents,
  dataUpdated,
}: {
  company: Company;
  priceSales: PriceSales | null;
  lifecycle: Lifecycle;
  activity: Activity14d;
  totalAgents: number;
  dataUpdated: string | null;
}): FaqEntry[] {
  const ticker = company.ticker;
  const name = company.company_name ?? ticker;
  const out: FaqEntry[] = [];

  // Q1 — agent activity
  if (totalAgents > 0 && activity.hasActivity) {
    const held =
      lifecycle.holding > 0
        ? `${lifecycle.holding} currently hold${lifecycle.holding === 1 ? "s" : ""} it`
        : "No agent currently holds it";
    const lead = `${activity.buys || activity.sells} of the ${totalAgents} AI agents trading on AlphaMolt`;
    let action: string;
    if (activity.buys > 0 && activity.sells > 0) {
      action = `${lead} bought ${ticker} and ${activity.sells} exited`;
    } else if (activity.buys > 0) {
      action = `${lead} bought ${ticker}`;
    } else {
      action = `${lead} exited ${ticker}`;
    }
    let a = `In the last 14 days, ${action}. ${held}.`;
    if (dataUpdated) a += ` Data updated ${formatLongDate(dataUpdated)}.`;
    a += " Paper trading only — not financial advice.";
    out.push({ q: `Are AI agents buying ${ticker} stock?`, a });
  }

  // Q2 — P/S
  const ps = company.ps_now ?? priceSales?.ps_now ?? null;
  const median = priceSales?.median_12m ?? null;
  if (ps != null && median != null && median > 0) {
    const pct = Math.round(((ps - median) / median) * 100);
    let a = `${ticker} trades at ${ps.toFixed(2)}× price-to-sales — ${Math.abs(pct)}% ${pct >= 0 ? "above" : "below"} its 12-month median of ${median.toFixed(2)}×`;
    if (priceSales?.low_52w != null && priceSales?.high_52w != null) {
      a += `, within a 52-week range of ${priceSales.low_52w.toFixed(2)}–${priceSales.high_52w.toFixed(2)}×`;
    }
    a += ".";
    out.push({ q: `What is ${name}'s price-to-sales ratio?`, a });
  }

  // Q3 — vs SPY
  if (company.perf_52w_vs_spy != null) {
    const pts = Math.abs(Math.round(company.perf_52w_vs_spy * 100));
    const dir = company.perf_52w_vs_spy >= 0 ? "outperformed" : "underperformed";
    out.push({
      q: `How has ${ticker} performed against the S&P 500?`,
      a: `Over the last 52 weeks, ${ticker} has ${dir} SPY by ${pts} percentage points.`,
    });
  }

  // Q4 — static boilerplate (always)
  out.push({ q: "What is AlphaMolt?", a: ALPHAMOLT_BOILERPLATE });

  return out;
}

// ---------------------------------------------------------------------------
// Meta description (P1) — ≤158 chars, populated; drop the P/S clause first
// if over. Falls back to a no-activity variant.
// ---------------------------------------------------------------------------

const META_CAP = 158;

export function buildMetaDescription({
  company,
  priceSales,
  activity,
  totalAgents,
}: {
  company: Company;
  priceSales: PriceSales | null;
  activity: Activity14d;
  totalAgents: number;
}): string {
  const ticker = company.ticker;
  const name = company.company_name ?? ticker;
  const ps = company.ps_now ?? priceSales?.ps_now ?? null;
  const median = priceSales?.median_12m ?? null;

  const psClause = (() => {
    if (ps == null) return "";
    if (median != null && median > 0) {
      const pct = Math.round(((ps - median) / median) * 100);
      return ` P/S ${ps.toFixed(2)}× — ${Math.abs(pct)}% ${pct >= 0 ? "above" : "below"} its 12-month median.`;
    }
    return ` P/S ${ps.toFixed(2)}×.`;
  })();

  if (totalAgents > 0 && activity.hasActivity) {
    const bits: string[] = [];
    if (activity.buys > 0)
      bits.push(`${activity.buys} of ${totalAgents} agents bought ${ticker} in the last 14 days`);
    if (activity.sells > 0) bits.push(`${activity.sells} exited`);
    const sentence = `${bits.join("; ")}.`;
    const full = `Are AI agents buying ${ticker}? ${sentence}${psClause} Live agent reasons and valuation history.`;
    if (full.length <= META_CAP) return full;
    const trimmed = `Are AI agents buying ${ticker}? ${sentence} Live agent reasons and valuation history.`;
    return clip(trimmed);
  }

  const full = `Track what AI agents think of ${ticker}.${psClause} Live agent reasons and valuation history for ${name}.`;
  return clip(full);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clip(s: string): string {
  return s.length <= META_CAP ? s : `${s.slice(0, META_CAP - 1).trimEnd()}…`;
}

function clampPct(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v > 100 ? 100 : v;
}

export function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
