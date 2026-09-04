/**
 * A portfolio rendered as one document, for review by another model.
 *
 * The consumer here is not a spreadsheet — it is an LLM being asked "what do
 * you think of this book?". That decides almost every choice below:
 *
 * * **Markdown, not CSV.** Half the value is the prose: why each position was
 *   opened, what would break the thesis, what the agents were told to do. A
 *   CSV either drops that or buries multi-sentence text in quoted cells.
 * * **Strategy first, positions second.** A reviewer handed 16 tickers can
 *   only comment on 16 tickers. Handed the mandate, the team and the sell
 *   discipline, it can say whether the positions match the stated strategy —
 *   which is the question worth asking.
 * * **Losses included, in full.** Closed positions and their realised P&L are
 *   part of the record. An export that quietly showed only current holdings
 *   would invite a review of a portfolio that never existed.
 * * **The as-of is stated, not implied.** Marks are close-to-close, so a
 *   reviewer told "current price" during market hours would be misled about
 *   figures that are up to a day old. It says so, once, at the top.
 *
 * Pure: no fetch, no React, no server actions (`tests/test_portfolio_export.py`).
 */

export type ExportHolding = {
  ticker: string;
  name: string | null;
  shares: number;
  avgCost: number;
  price: number | null;
  marketValue: number;
  weightPct: number;
  unrealisedUsd: number;
  unrealisedPct: number | null;
  firstBoughtAt: string | null;
  openedBy: string | null;
  thesis: ExportThesis | null;
};

export type ExportThesis = {
  openedAt: string | null;
  text: string | null;
  extendSignals: ExportSignal[];
  breakSignals: ExportSignal[];
};

export type ExportSignal = {
  field: string;
  op: string;
  value: number | string;
  description?: string | null;
  /**
   * Three distinct states, and they must stay distinct:
   *   true      — the signal is true right now
   *   false     — checked, not true
   *   null      — checked, and it CANNOT be evaluated (no data for the field)
   *   undefined — not checked at all
   * A reviewer told "cannot be evaluated" about a healthy signal is being
   * told something false, so `undefined` renders as nothing, not as null.
   */
  firing?: boolean | null;
};

export type ExportTrade = {
  executedAt: string;
  ticker: string;
  side: string;
  quantity: number;
  price: number;
  grossUsd: number;
  agent: string | null;
  /** The agent's own words at the time — the reason this row exists. */
  rationale: string | null;
  /** Realised gain/loss, sells only. */
  realisedUsd?: number | null;
};

export type ExportClosed = {
  ticker: string;
  realisedUsd: number;
  lastSoldAt: string | null;
};

/**
 * How candidates reach the buyer at all — the portfolio's screen.
 *
 * Without this a reviewer can critique the 16 names it sees but not the far
 * more interesting question: whether the filter that produced them is the
 * right filter. "Why no financials?" has a boring answer if the screen
 * excludes the sector, and an interesting one if it doesn't.
 *
 * Filters arrive pre-rendered as the labels the owner sees on the Universe
 * tab (`screenFilterLabel`), so the pack and the page describe the same screen
 * in the same words rather than in two dialects.
 */
export type ExportUniverse = {
  presetLabel: string | null;
  brief: string | null;
  filters: string[];
  weights: Record<string, number> | null;
  topN: number | null;
  aiBudget: number | null;
  hideRejected: boolean | null;
};

export type ExportData = {
  name: string;
  slug: string;
  mandate: string | null;
  isPublic: boolean;
  generatedAt: string;
  /** Date the prices behind every value are struck (a close, not live). */
  pricedAsOf: string | null;
  totalValue: number;
  cash: number;
  startingCash: number;
  returnPct: number | null;
  inceptionDate: string | null;
  holdings: ExportHolding[];
  trades: ExportTrade[];
  closed: ExportClosed[];
  team: { name: string; role: string | null; brief: string | null }[];
  universe: ExportUniverse | null;
  sellDiscipline: Record<string, unknown> | null;
  cashReserve: Record<string, unknown> | null;
};

/** The whole document. */
export function buildPortfolioExport(d: ExportData): string {
  const s: string[] = [];
  s.push(`# ${d.name} — portfolio review pack`);
  s.push("");
  s.push(preamble(d));
  s.push("");
  s.push(...strategySection(d));
  s.push(...universeSection(d));
  s.push(...positionsSection(d));
  s.push(...thesesSection(d));
  s.push(...tradesSection(d));
  s.push(...closedSection(d));
  s.push(...questionsSection());
  return s.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * What this is and how old it is.
 *
 * The staleness line is not boilerplate. Marks come from the last close, so a
 * model told these are "current" prices would reason about a move that has
 * already happened, or miss one that has. Saying it once here is cheaper than
 * every figure below carrying a caveat.
 */
function preamble(d: ExportData): string {
  const asOf = d.pricedAsOf
    ? `Prices are the closing marks for ${d.pricedAsOf}`
    : "Prices are the most recent available closing marks";
  return [
    `_Generated ${d.generatedAt} from AlphaMolt. Paper portfolio — no real money._`,
    "",
    `${asOf}, not live quotes, so intraday moves are not reflected.`,
    "All figures in USD. Weights are of total value including cash.",
  ].join("\n");
}

function strategySection(d: ExportData): string[] {
  const s = ["## Strategy", ""];
  s.push(`- **Return since inception:** ${pct(d.returnPct)}`);
  s.push(`- **Total value:** ${money(d.totalValue)} (cash ${money(d.cash)})`);
  s.push(`- **Capital contributed:** ${money(d.startingCash)}`);
  if (d.inceptionDate) s.push(`- **Running since:** ${d.inceptionDate}`);
  s.push(`- **Positions:** ${d.holdings.length}`);
  s.push("");

  if (d.mandate) {
    s.push("### Mandate", "", quote(d.mandate), "");
  }
  if (d.team.length > 0) {
    s.push("### Agents running this book", "");
    for (const a of d.team) {
      s.push(`**${a.name}**${a.role ? ` — ${a.role}` : ""}`);
      if (a.brief) s.push("", quote(a.brief));
      s.push("");
    }
  }
  const policies = policyLines(d);
  if (policies.length > 0) {
    s.push("### Sell discipline & cash policy", "", ...policies, "");
  }
  return s;
}

/**
 * The owner-configured rules, spelled out rather than dumped as JSON.
 *
 * A reviewer that can see "sells are blocked unless a recorded break signal is
 * firing" can tell you whether the positions below are stuck for a good reason.
 * Given `{"require_fired_break_signal": true}` it mostly cannot.
 */
function policyLines(d: ExportData): string[] {
  const out: string[] = [];
  const sd = d.sellDiscipline ?? {};
  const grace = numOrNull(sd["grace_period_days"]);
  if (grace != null) {
    out.push(
      grace > 0
        ? `- Positions are not reviewed for sale in their first **${grace} days**.`
        : "- No holding period — positions can be sold from day one.",
    );
  }
  if (sd["require_fired_break_signal"] === true) {
    out.push("- A sell requires a recorded break signal to actually be firing.");
  } else if (sd["require_fired_break_signal"] === false) {
    out.push("- Sells do not require a break signal to be firing.");
  }
  if (sd["relative_fields_change_only"] === true) {
    out.push(
      "- Price-relative signals must be written as change-since-purchase, " +
        "not as a static level.",
    );
  }
  const reserve = numOrNull((d.cashReserve ?? {})["reserve_pct"]);
  if (reserve != null) {
    out.push(`- The screen buyer stops buying at **${reserve}% cash**.`);
  }
  return out;
}

/**
 * The screen: what the buyers were allowed to choose from, and how it ranked.
 *
 * Placed before the positions on purpose. Read in this order a reviewer can
 * ask whether the book reflects the screen; read after, it can only take the
 * holdings as given.
 */
function universeSection(d: ExportData): string[] {
  const u = d.universe;
  if (!u) return [];
  const s = ["## Universe — what the buyers can choose from", ""];
  if (u.presetLabel) s.push(`**Screen:** ${u.presetLabel}`, "");
  if (u.brief) s.push(quote(u.brief), "");

  if (u.filters.length > 0) {
    s.push("**A candidate must pass all of:**", "");
    for (const f of u.filters) s.push(`- ${f}`);
    s.push("");
  } else {
    s.push(
      "No filters — the whole liquid US universe is eligible before ranking.",
      "",
    );
  }

  if (u.weights) {
    const parts = Object.entries(u.weights)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `${k} ${v}%`);
    if (parts.length > 0) {
      s.push(`**Ranked by:** ${parts.join(" · ")}`, "");
    }
  }
  const notes: string[] = [];
  if (u.topN != null) {
    notes.push(
      `Only the top **${u.topN}** ranked names are offered to the buyers.`,
    );
  }
  if (u.aiBudget != null) {
    notes.push(
      `AI research card can move a name up to **${u.aiBudget}σ** in the ranking.`,
    );
  }
  if (u.hideRejected) {
    notes.push(
      "Names a buyer already passed on are hidden for ~30 days, so they are " +
        "absent from the ranking rather than rejected again.",
    );
  }
  if (notes.length > 0) s.push(...notes.map((n) => `- ${n}`), "");
  return s;
}

function positionsSection(d: ExportData): string[] {
  if (d.holdings.length === 0) return ["## Positions", "", "None.", ""];
  const s = ["## Positions", ""];
  s.push(
    "| Ticker | Shares | Avg cost | Price | Value | Weight | Unrealised | First bought | Opened by |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
  );
  for (const h of d.holdings) {
    s.push(
      `| ${h.ticker}${h.name ? ` — ${h.name}` : ""} | ${num(h.shares)} | ` +
        `${money(h.avgCost)} | ${h.price == null ? "—" : money(h.price)} | ` +
        `${money(h.marketValue)} | ${h.weightPct.toFixed(2)}% | ` +
        `${money(h.unrealisedUsd)} (${pct(h.unrealisedPct)}) | ` +
        `${h.firstBoughtAt ?? "—"} | ${h.openedBy ?? "—"} |`,
    );
  }
  s.push("");
  return s;
}

/**
 * One block per position: why it was bought, and what would prove it wrong.
 *
 * The firing flag matters more than it looks. A break signal that is already
 * true is a position the discipline says should be gone; one that cannot be
 * evaluated is a tripwire that will never trip. A reviewer should be able to
 * see both, so unevaluable signals are marked rather than silently shown as
 * "not firing".
 */
function thesesSection(d: ExportData): string[] {
  const withThesis = d.holdings.filter((h) => h.thesis);
  if (withThesis.length === 0) return [];
  const s = ["## Why each position was opened", ""];
  for (const h of withThesis) {
    const t = h.thesis!;
    s.push(`### ${h.ticker}${t.openedAt ? ` — opened ${t.openedAt}` : ""}`, "");
    if (t.text) s.push(t.text, "");
    if (t.breakSignals.length > 0) {
      s.push("**Would break the thesis:**", "");
      for (const sig of t.breakSignals) s.push(signalLine(sig));
      s.push("");
    }
    if (t.extendSignals.length > 0) {
      s.push("**Would confirm it:**", "");
      for (const sig of t.extendSignals) s.push(signalLine(sig));
      s.push("");
    }
  }
  return s;
}

function signalLine(sig: ExportSignal): string {
  const state =
    sig.firing === true
      ? " — **FIRING NOW**"
      : sig.firing === null
        ? " — _cannot be evaluated (no data for this field)_"
        : "";
  const desc = sig.description ? ` — ${sig.description}` : "";
  return `- \`${sig.field} ${sig.op} ${sig.value}\`${desc}${state}`;
}

/** Every trade, newest first, each with the agent's reason at the time. */
function tradesSection(d: ExportData): string[] {
  if (d.trades.length === 0) return [];
  const s = [`## Every trade (${d.trades.length})`, ""];
  for (const t of d.trades) {
    const realised =
      t.realisedUsd == null
        ? ""
        : ` · realised ${money(t.realisedUsd)}`;
    s.push(
      `**${t.executedAt} — ${t.side.toUpperCase()} ${num(t.quantity)} ` +
        `${t.ticker} @ ${money(t.price)}** = ${money(t.grossUsd)}` +
        `${realised}${t.agent ? ` · ${t.agent}` : ""}`,
    );
    if (t.rationale) s.push("", quote(t.rationale));
    s.push("");
  }
  return s;
}

/**
 * Positions that were sold, and what they cost or made.
 *
 * Present even when the number is ugly. A review pack that shows only what is
 * still held describes a portfolio that never existed, and invites praise for
 * survivors while hiding what was cut.
 */
function closedSection(d: ExportData): string[] {
  if (d.closed.length === 0) return [];
  const s = ["## Closed positions", "", "| Ticker | Realised | Last sold |", "|---|---:|---|"];
  for (const c of d.closed) {
    s.push(`| ${c.ticker} | ${money(c.realisedUsd)} | ${c.lastSoldAt ?? "—"} |`);
  }
  const total = d.closed.reduce((a, c) => a + c.realisedUsd, 0);
  s.push(`| **Total** | **${money(total)}** | |`, "");
  return s;
}

/**
 * What to ask the reviewing model.
 *
 * Without this the likely prompt is "what do you think?", which gets a generic
 * answer. These are the questions the data below can actually support.
 */
function questionsSection(): string[] {
  return [
    "## Questions worth asking a reviewer",
    "",
    "1. Do the positions actually match the stated mandate, or has the book drifted?",
    "2. Which theses are weakest on the evidence given — and which break signals look unfalsifiable or already true?",
    "3. Does the screen itself (filters and ranking weights) select for the kind of business the mandate describes?",
    "4. Where is the concentration risk (single name, sector, factor) that the weights alone don't show?",
    "5. On the closed positions, were the exits consistent with the sell discipline above?",
    "6. What would you sell first, and what is missing from this book entirely?",
    "",
  ];
}

// -- formatting ------------------------------------------------------------

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function num(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Filename for the download: stable, dated, no spaces. */
export function exportFilename(slug: string, generatedAt: string): string {
  const day = generatedAt.slice(0, 10);
  return `${slug}-portfolio-${day}.md`;
}
