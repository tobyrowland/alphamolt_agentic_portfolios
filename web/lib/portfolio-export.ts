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
 * * **Known defects are declared, with their remedies.** A reviewer handed
 *   only the current state re-derives the same closed issues every time, and
 *   a finding that restates one costs a round of reading for nothing. The
 *   status of each remedy is read from THIS book's config, so a defence that
 *   is switched off here is reported as off.
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
/**
 * One hired agent, with the knobs that change what the book DOES.
 *
 * `kind` matters more than the name: a self-sourced buyer never sees the
 * screen, so a methodology that describes one pipeline for every agent is
 * simply wrong on a book that has one — and wrong in a way a reviewer cannot
 * detect, because the positions look the same either way.
 */
export type ExportAgent = {
  name: string;
  role: string | null;
  brief: string | null;
  kind: "screen-buyer" | "self-sourced-buyer" | "reviewer" | "other";
  /** What it re-reads each run, for a self-sourced buyer. */
  sourcedFrom?: string | null;
  cadenceHours: number | null;
  convictionGate: number | null;
  /** Percent-of-book knobs, only those that apply to this agent's kind. */
  targetPct?: number | null;
  minPct?: number | null;
  addPct?: number | null;
  maxPct?: number | null;
  sellThreshold?: number | null;
};

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
  team: ExportAgent[];
  universe: ExportUniverse | null;
  sellDiscipline: Record<string, unknown> | null;
  cashReserve: Record<string, unknown> | null;
};

/** Operators compared against a single current value. */
const STATIC_OPS: Record<string, (a: number, b: number) => boolean> = {
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/**
 * Mark each signal firing / not firing / unevaluable against today's facts.
 *
 * Three outcomes, and the difference between the last two is the point:
 *
 * * a static operator with a current value → a real true/false;
 * * a static operator with NO current value → `null`, meaning this tripwire
 *   cannot fire and never will, whatever the stock does. That is a fact about
 *   the sell discipline, not a gap in the export, so it is stated;
 * * a `change_pct_*` operator → left `undefined`. These compare against the
 *   value frozen at purchase, which the reviewer evaluates at review time and
 *   this pack does not carry. Guessing false would misreport an armed
 *   tripwire as quiet.
 */
export function markFiring(
  signals: ExportSignal[],
  facts: Record<string, number> | undefined,
): ExportSignal[] {
  return signals.map((sig) => {
    if (!(sig.op in STATIC_OPS)) return sig; // change_pct_* — not checked here
    const current = facts?.[sig.field];
    const threshold = Number(sig.value);
    if (current == null || !Number.isFinite(threshold)) {
      return { ...sig, firing: null };
    }
    return { ...sig, firing: STATIC_OPS[sig.op](current, threshold) };
  });
}

/** The whole document. */
export function buildPortfolioExport(d: ExportData): string {
  const s: string[] = [];
  s.push(`# ${d.name} — portfolio review pack`);
  s.push("");
  s.push(preamble(d));
  s.push("");
  s.push(...strategySection(d));
  s.push(...universeSection(d));
  s.push(...methodologySection(d));
  s.push(...fixesSection(d));
  s.push(...positionsSection(d));
  s.push(...thesesSection(d));
  s.push(...tradesSection(d));
  s.push(...closedSection(d));
  s.push(...limitationsSection(d));
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

/**
 * How a name gets into this book and how it leaves — for THIS team.
 *
 * The first version of this described a single pipeline: screen, rank,
 * shortlist, judge, size, record, review. That is the house pipeline and it is
 * wrong the moment a book hires a self-sourced buyer, which never sees the
 * screen at all — it re-reads what the portfolio already owns and adds to it.
 * On the Scrappy Fightback book that agent made a real trade (a PODD top-up),
 * and a reviewer reading the generic description would have attributed it to
 * the screen. Wrong in a way a reviewer cannot detect from the positions.
 *
 * So the steps are derived from the agents actually hired, with their real
 * cadences and gates. A methodology note is only worth including if it is true
 * of the specific book it is attached to.
 */
function methodologySection(d: ExportData): string[] {
  const screenBuyers = d.team.filter((a) => a.kind === "screen-buyer");
  const selfSourced = d.team.filter((a) => a.kind === "self-sourced-buyer");
  const reviewers = d.team.filter((a) => a.kind === "reviewer");
  if (d.team.length === 0) return [];

  const s = ["## How this book is run", ""];
  const topN = d.universe?.topN;

  if (screenBuyers.length > 0) {
    s.push(
      `**Buying from the screen** — ${list(screenBuyers.map((a) => a.name))}:`,
      "",
      "1. **Screen.** The filters above are applied to every liquid US-listed " +
        "stock (≥ $5M average daily traded value, ≥ $1 close). A name failing " +
        "any filter is never seen.",
      "2. **Rank.** Survivors score on the weighted lenses above. Each " +
        "component is a **percentile within the filtered set**, not an " +
        "absolute measure, so a name ranks well by beating the other " +
        "candidates rather than by being good outright. An AI research card " +
        "(moat, growth durability, earnings quality) and an adversarial " +
        "bull/bear pair then nudge it.",
      topN != null
        ? `3. **Shortlist.** Only the top ${topN} reach the buyer. Everything ` +
          "below is invisible to it, however good."
        : "3. **Shortlist.** A fixed top slice reaches the buyer.",
      "4. **Judge.** The buyer evaluates each shortlisted name **one at a " +
        "time** against its own brief, returning BUY/PASS with a 1-5 " +
        "conviction, a written thesis and machine-checkable signals. It sees " +
        "fundamentals, valuation history, the research card, the bull/bear " +
        "verdicts and a recent-news snippet. It is **not told the cash " +
        "position** — affordability is decided afterwards, so a good business " +
        "is not rejected for being briefly unaffordable.",
      "5. **Size and record.** Qualifying names are bought from the shared " +
        "cash pool, and every buy freezes the company's numbers at that " +
        "moment alongside the thesis.",
      "",
    );
    for (const a of screenBuyers) s.push(...agentLine(a));
    s.push("");
  }

  if (selfSourced.length > 0) {
    s.push(
      "**Buying without the screen** — these agents never see the screen. " +
        "They bring their own candidates and run BEFORE the screen buyer each " +
        "cycle, so the cash they spend is gone before it drafts:",
      "",
    );
    for (const a of selfSourced) {
      s.push(
        `- **${a.name}** re-reads ${a.sourcedFrom ?? "its own source"} each ` +
          "run and buys from it on the same per-name judgement the screen " +
          "buyer uses.",
      );
      s.push(...agentLine(a).map((l) => `  ${l}`));
    }
    s.push("");
  }

  if (reviewers.length > 0) {
    s.push(
      `**Selling** — ${list(reviewers.map((a) => a.name))}. The agent that ` +
        "buys is never the agent that sells. The reviewer re-reads each " +
        "holding against its recorded thesis, under the sell rules above, and " +
        "exits the **whole position or none** — it does not trim.",
      "",
    );
    for (const a of reviewers) s.push(...agentLine(a));
    s.push("");
  }

  s.push(
    "The owner can also sell any holding by hand at any time, which bypasses " +
      "every rule above.",
    "",
  );
  return s;
}

/** The knobs that decide what an agent actually does, stated as a line. */
function agentLine(a: ExportAgent): string[] {
  const bits: string[] = [];
  if (a.cadenceHours != null) bits.push(`runs ${cadence(a.cadenceHours)}`);
  if (a.convictionGate != null) {
    bits.push(
      `only acts at conviction **${a.convictionGate}/5** ` +
        "(anything lower is interest, not a trade)",
    );
  }
  if (a.sellThreshold != null) {
    bits.push(`sells at conviction ≥ **${a.sellThreshold}/5**`);
  }
  if (a.targetPct != null) bits.push(`targets **${a.targetPct}%** per position`);
  if (a.minPct != null) bits.push(`will not open below ${a.minPct}%`);
  if (a.addPct != null) bits.push(`adds **${a.addPct}%** at a time`);
  if (a.maxPct != null) bits.push(`up to a **${a.maxPct}%** ceiling`);
  return bits.length > 0 ? [`- _${a.name}: ${bits.join(", ")}._`] : [];
}

function cadence(hours: number): string {
  if (hours <= 24) return "daily";
  if (hours <= 24 * 7) return "weekly";
  if (hours <= 24 * 31) return "monthly";
  return `every ${Math.round(hours / 24)} days`;
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One defect the system has already closed, and whether the remedy is live
 * on THIS book.
 *
 * The list is system-level and hard-coded, because that is what it is: a
 * record of changes made to the pipeline, not a property of any one
 * portfolio. What IS per-portfolio is `status` — a defence that exists in the
 * codebase but is switched off here is not fixed here, and saying otherwise
 * would be the one thing this section must never do.
 */
type KnownFix = {
  title: string;
  /** What actually went wrong, concretely enough to recognise elsewhere. */
  failure: string;
  /** What was built in response. */
  remedy: string;
  /** Where it is enforced, so a reviewer can go and read it. */
  where: string;
  status: (d: ExportData) => FixStatus;
};

/**
 * Four states, and they are not interchangeable. `true` / `false` are a
 * setting's real position on this book; `null` means the remedy is not a
 * setting at all and cannot be turned off; `"n/a"` means it is a corrective
 * tool this book has had no occasion to use — which is not the same as a
 * defence being switched off, and must not be reported as one.
 */
type FixStatus = { on: boolean | null | "n/a"; note?: string };

const KNOWN_FIXES: KnownFix[] = [
  {
    title: "Theses that were false the moment they were written",
    failure:
      "The buyer authored the break signals for its own position, and could " +
      "write one the screen had already guaranteed — a screen filtering " +
      "`perf_52w_vs_spy < -20` paired with a break signal of " +
      "`perf_52w_vs_spy < -20`. Every candidate arrived pre-broken, so the " +
      "reviewer could exit on day one against a tripwire that was never a " +
      "test of anything.",
    remedy:
      "A break signal that already evaluates true against the buy-time " +
      "snapshot is dropped at record time and logged. It is a correctness " +
      "invariant rather than a preference: nothing wants a position whose " +
      "exit trigger is met at purchase.",
    where: "`theses.record_thesis` / `theses._drop_already_true`",
    status: () => ({
      on: null,
      note:
        "Applies when a thesis is recorded, so a position opened before it " +
        "landed can still carry one — the firing column under each thesis is " +
        "where to check.",
    }),
  },
  {
    title: "Confirmation signals doing duty as falsification tests",
    failure:
      "Extend (confirmation) signals were being written as thresholds the " +
      "screen guarantees are unreachable — `perf_52w_vs_spy > 0` on a name " +
      "selected for being 20% behind the index. The reviewer then read an " +
      "unmet wish as evidence against the position and sold while its own " +
      "note said no break signal had fired.",
    remedy:
      "Operator rules that differ by signal kind. A static upside threshold " +
      "is legitimate on a **break** signal (it is a take-profit) and banned " +
      "on an **extend**; a static downside threshold is banned on both " +
      "(that is the born-broken case); `==` and `!=` are banned outright. " +
      "Price-relative fields must be written as change-since-purchase, which " +
      "is structurally immune because the delta at purchase is zero. The " +
      "buyer's prompt teaches the rules, so signals are authored compliant " +
      "rather than silently filtered.",
    where: "`thesis_policy.signal_permitted(..., kind=)`",
    status: (d) => {
      const v = (d.sellDiscipline ?? {})["relative_fields_change_only"];
      if (v === true) return { on: true };
      if (v === false) {
        return {
          on: false,
          note:
            "Switched off on this book, so signals here may carry static " +
            "levels on price-relative fields.",
        };
      }
      return { on: null, note: "Not set on this book; the default applies." };
    },
  },
  {
    title: "Positions bought and sold within seconds",
    failure:
      "Buyers and reviewers run in the same heartbeat over the same book, " +
      "buyers first. With no holding period, a name could be bought and sold " +
      "inside the same run — three were, in 80 to 86 seconds — and one " +
      "turnaround thesis was closed six days in while the reviewer's own " +
      "note called the fundamentals exceptionally strong.",
    remedy:
      "A grace period. The reviewer skips positions younger than it entirely " +
      "and journals them rather than judging them. The owner's manual Sell " +
      "button stays the escape hatch for a genuine blow-up.",
    where: "`thesis_policy.within_grace_period` / `portfolio_reviewer`",
    status: (d) => {
      const days = numOrNull((d.sellDiscipline ?? {})["grace_period_days"]);
      if (days == null) return { on: null, note: "Not set; the default applies." };
      if (days > 0) return { on: true, note: `${days} days.` };
      return {
        on: false,
        note:
          "Set to 0 on this book — a position can be sold on the same day it " +
          "is bought.",
      };
    },
  },
  {
    title: "Sells with nothing actually broken",
    failure:
      "A SELL verdict needed only the reviewer's own conviction. Nothing " +
      "required the recorded thesis to have failed, so the exit rationale " +
      "and the recorded break signals could disagree with each other and the " +
      "position still closed.",
    remedy:
      "The reviewer refuses a SELL unless a recorded break signal is " +
      "actually firing. It self-disables where there is nothing to check — " +
      "no thesis, no signals, a failed evaluation — so a position can never " +
      "become unsellable, and suppressed sells are journalled rather than " +
      "folded into the HOLD list.",
    where: "`thesis_policy.sell_is_permitted`",
    status: (d) => {
      const v = (d.sellDiscipline ?? {})["require_fired_break_signal"];
      if (v === true) {
        return {
          on: true,
          note:
            "Only as strong as the signals it reads — see the unevaluable " +
            "count under *What this record cannot tell you*.",
        };
      }
      if (v === false) {
        return { on: false, note: "Switched off on this book." };
      }
      return { on: null, note: "Not set on this book; the default applies." };
    },
  },
  {
    title: "Names locked out by sells since ruled invalid",
    failure:
      "A sold name cannot be re-bought for 90 days, derived from the " +
      "immutable trade tape. When a batch of sells was later judged to have " +
      "been made by a process that no longer exists, the names stayed " +
      "excluded anyway — including names still passing every screen filter.",
    remedy:
      "A dated, per-portfolio exemption: sells before a stated instant do " +
      "not count toward the cooldown. It corrects the consequence instead of " +
      "editing the tape, can only ever shorten the lookback, and goes inert " +
      "on its own once those sells age past 90 days.",
    where: "`thesis_policy.cooldown_cutoff`",
    status: (d) => {
      const raw = (d.sellDiscipline ?? {})["rebuy_cooldown_ignores_sells_before"];
      if (typeof raw === "string" && raw.length > 0) {
        return { on: true, note: `Sells before ${raw} are exempt on this book.` };
      }
      return {
        on: "n/a",
        note:
          "No exemption set here, so the full 90-day cooldown applies to " +
          "every past sell. It is an operator correction rather than a " +
          "standing preference — a book with no invalidated sells has no " +
          "occasion for one.",
      };
    },
  },
  {
    title: "A buyer that never had any money to spend",
    failure:
      "Self-sourced buyers run before the screen draft, and the draft bought " +
      "until cash hit its floor — so a buyer scheduled first always arrived " +
      "to find the floor already reached. One made zero trades in its entire " +
      "life while the screen buyer made 25 over the same book. Its own " +
      "funding gate compounded it by asking for a percentage of net asset " +
      "value, which on a fully-invested book is a wall rather than a buffer.",
    remedy:
      "An owner-set cash reserve on the portfolio — the draft stops there " +
      "and leaves the difference for the buyers that run before it — and a " +
      "funding gate asked in dollars (is there enough for one " +
      "worthwhile add?) rather than as a share of the book.",
    where: "`cash_policy.reserve_pct` / `double_down.plan_double_down`",
    status: (d) => {
      const pctv = numOrNull((d.cashReserve ?? {})["reserve_pct"]);
      if (pctv == null) return { on: null, note: "Not set; the default applies." };
      return {
        on: true,
        note:
          `${pctv}%. A reserve is a transfer of budget to the buyers that ` +
          "run first, not a renewable supply — only sells and deposits " +
          "create cash.",
      };
    },
  },
  {
    title: "Passes that were really about the cash balance",
    failure:
      "The per-name buy prompt stated the cash position, and a PASS is " +
      "recorded as a ~30-day hide on the screen. Names were being " +
      "quarantined for reasons like *the portfolio lacks sufficient " +
      "cash* — indistinguishable, a month later, from a judgement that " +
      "the business was bad.",
    remedy:
      "The per-name prompt no longer carries a cash figure. That call " +
      "answers whether this equity fits this mandate at today's price; " +
      "affordability is the draft's decision downstream. The prioritisation " +
      "call, whose whole job is ranking under scarcity, still sees cash.",
    where: "`llm_watchlist_buyer` (per-name prompt)",
    status: () => ({
      on: null,
      note:
        "Hides recorded before this landed may still be affordability " +
        "passes wearing a mandate reason.",
    }),
  },
];

/**
 * What has already been fixed — so the reviewer spends its attention
 * elsewhere.
 *
 * A reviewer handed only the current state re-derives the same well-known
 * defects every time, and a finding that restates a closed issue costs the
 * owner a round of reading for nothing. Two things make this worth the words
 * it takes:
 *
 *  * **The status is per-portfolio.** A defence that is switched off here is
 *    reported as off, so the section can never read as a claim that the book
 *    is safe when the config says it isn't.
 *  * **The shape generalises.** Every entry below shares one of two root
 *    causes, named at the end. That is the part a reviewer can actually use
 *    to go and find the NEXT one.
 */
function fixesSection(d: ExportData): string[] {
  const s = ["## What has already been fixed", ""];
  s.push(
    "Known defects in this pipeline that have been diagnosed and closed, with " +
      "whether each remedy is live on this book. **Findings that restate one " +
      "of these are not useful.** Findings that show a remedy is not actually " +
      "load-bearing here, or that the same failure exists somewhere this list " +
      "does not reach, are.",
    "",
  );

  for (const fix of KNOWN_FIXES) {
    const st = fix.status(d);
    const flag =
      st.on === true
        ? "**Active on this book.**"
        : st.on === false
          ? "**Not active on this book** — treat the failure above as live here."
          : st.on === "n/a"
            ? "**Not used on this book.**"
            : "**Unconditional** — not a setting, applies to every portfolio.";
    s.push(`### ${fix.title}`, "");
    s.push(`- **Was:** ${fix.failure}`);
    s.push(`- **Now:** ${fix.remedy}`);
    s.push(`- **Enforced in:** ${fix.where}`);
    s.push(`- **Status:** ${flag}${st.note ? ` ${st.note}` : ""}`);
    s.push("");
  }

  s.push(
    "### The shape these share",
    "",
    "Both root causes are worth carrying into the rest of the review, " +
      "because neither is visible in the output they produce:",
    "",
    "1. **One agent writes the criteria a different agent enforces, and " +
      "nothing checks those criteria against reality at the moment they are " +
      "written.** The buyer authoring its own falsification test is the " +
      "clearest case, but the pattern recurs anywhere a rule is authored in " +
      "one place and read in another.",
    "2. **Ordering inside a single run decides the outcome and leaves no " +
      "trace.** Buyers run before reviewers; self-sourced buyers run before " +
      "the draft. The positions look identical either way, so a sequencing " +
      "bug is invisible in the book and only shows up in the timestamps.",
    "",
    "The design choice underneath all of it was left deliberately in place: " +
      "the buyer still authors the conditions under which its own position " +
      "will be sold. The fixes constrain what it may write and when the " +
      "reviewer may act; they do not move the judgement to a different " +
      "agent.",
    "",
  );
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
/**
 * What this record cannot tell you.
 *
 * The most useful thing in the pack, and the easiest to omit. A reviewer that
 * does not know the marks are stale, or that some tripwires are inert, will
 * spend its critique on artefacts and miss the real weaknesses. Where a
 * limitation is measurable it is MEASURED from this portfolio's own data
 * rather than asserted, so the sentence cannot quietly go out of date.
 */
function limitationsSection(d: ExportData): string[] {
  const s = ["## What this record cannot tell you", ""];

  const allSignals = d.holdings.flatMap((h) => [
    ...(h.thesis?.breakSignals ?? []),
    ...(h.thesis?.extendSignals ?? []),
  ]);
  const inert = allSignals.filter((sig) => sig.firing === null);
  if (inert.length > 0) {
    const fields = [...new Set(inert.map((sig) => sig.field))].sort();
    s.push(
      `- **${inert.length} of ${allSignals.length} recorded signals cannot be ` +
        `evaluated** (fields: ${fields.map((f) => `\`${f}\``).join(", ")}). ` +
        "No data reaches them, so those tripwires will never fire however far " +
        "the stock moves. Treat the sell discipline as weaker than the signal " +
        "list makes it look.",
    );
  }
  const changeOps = allSignals.filter((sig) => sig.firing === undefined).length;
  if (changeOps > 0) {
    s.push(
      `- ${changeOps} signal${changeOps === 1 ? "" : "s"} compare` +
        `${changeOps === 1 ? "s" : ""} against the value frozen at purchase ` +
        "(`change_pct_*`), so its live state is computed at review time and " +
        "is not in this pack.",
    );
  }

  s.push(
    "- **Prices are closing marks, not live.** Intraday moves, and anything " +
      "that happened after the as-of date above, are absent.",
    "- **Paper trading.** No commissions, spread, slippage, borrow, dividends, " +
      "or tax. Fills are struck at the closing price, which real execution " +
      "would not achieve.",
    "- All values are treated as USD, including any non-US listing.",
  );
  if (d.universe?.hideRejected) {
    s.push(
      "- A name a buyer passed on is hidden from the screen for ~30 days. " +
        "**An absence is therefore not always a judgement** — it may be a " +
        "name that was rejected once and has not been reconsidered since.",
    );
  }
  s.push(
    "- After a sell, the same name cannot be re-bought for 90 days, so some " +
      "absences are a cooling-off rule rather than a view.",
    "- The frozen thesis snapshots are the numbers **as at purchase**. Where a " +
      "figure looks stale against the position table, that is the point of it.",
    "",
  );
  return s;
}

function questionsSection(): string[] {
  return [
    "## Questions worth asking a reviewer",
    "",
    "1. Do the positions actually match the stated mandate, or has the book drifted?",
    "2. Which theses are weakest on the evidence given — and which break signals look unfalsifiable or already true?",
    "3. Does the screen itself (filters and ranking weights) select for the kind of business the mandate describes?",
    "4. Where is the concentration risk (single name, sector, factor) that the weights alone don't show?",
    "5. On the closed positions, were the exits consistent with the sell discipline above?",
    "6. Given the pipeline described above, where is the process itself most likely to go wrong — the screen, the ranking, the per-name judgement, or the sell rules?",
    "7. Taking the two root causes named under *What has already been fixed*, where else in this pipeline does the same shape appear — and what would you change there?",
    "8. What would you sell first, and what is missing from this book entirely?",
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
