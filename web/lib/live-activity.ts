/**
 * The live account's "what's happening" logic — pure, so the copy is testable.
 *
 * Between asking for a sync and a fill landing there was previously NO visible
 * signal at all: `syncLivePortfolioToAlpaca` gets an HTTP 204 from GitHub (no
 * run id, nothing persisted), and a mirror run can legitimately do NOTHING —
 * market shut, nothing drifted, execution switched off — so silence meant
 * either "working" or "never happened" and the owner couldn't tell which.
 *
 * `buildHubState` turns the signals that do exist into the sentences the hub
 * shows, including the honest quiet state. It is the copy contract, and
 * `tests/test_live_hub.py` pins it through `tests/ts_live_hub_runner.mjs`.
 *
 * Zero imports on purpose: no DB, no fetch, no React.
 */

// ---------------------------------------------------------------------------
// Inputs (shared with live-activity-query.ts / live-cash-query.ts)
// ---------------------------------------------------------------------------

export type HubSleeve = {
  portfolioId: string;
  displayName: string;
  /** Spendable cash allowance. */
  allowance: number;
  /** Mark-to-market value of this sleeve's own recorded holdings. */
  holdingsValue: number;
  /** Holdings in tickers its own paper book doesn't hold — work owed. */
  offBookValue: number;
  followsPortfolioId: string | null;
  /** Has any real capital ever been attributed to it? */
  everFunded: boolean;
};

export type HubLedgerEntry = {
  id: number;
  portfolioId: string;
  portfolioSlug: string;
  deltaUsd: number;
  reason: string;
  note: string | null;
  createdAt: string;
};

/**
 * A row from the `run_logs` journal: either the website asking for a mirror
 * (`live_mirror_dispatch`) or `alpaca_mirror.py` reporting what it actually
 * did (`live_mirror`) — the only source that knows a run happened AND why it
 * did nothing.
 */
export type MirrorRun = {
  kind: "dispatch" | "run";
  portfolioId: string | null;
  slug: string | null;
  /** run only: ok | market_closed | drift_refused | error */
  status: string | null;
  orders: number;
  placed: number;
  dryRun: boolean;
  createdAt: string;
};

export type HubFill = {
  id: string;
  portfolioId: string;
  ticker: string;
  side: string;
  qty: number;
  price: number;
  executedAt: string;
};

export type HubInput = {
  sleeves: HubSleeve[];
  ledger: HubLedgerEntry[];
  runs: MirrorRun[];
  fills: HubFill[];
  unallocated: number | null;
  brokerCash: number | null;
  nowMs: number;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type HubTone = "good" | "working" | "warn" | "danger" | "muted";

/**
 * What a line IS, independent of how it reads. The execution timeline sorts
 * lines into past / present / future and must not do that by pattern-matching
 * the copy — the sentences are a tested contract and are free to change.
 */
export type HubLineKind =
  | "dispatch"       // we asked for a run; it hasn't reported back
  | "offbook"        // positions still owed a restructure
  | "unlinked"       // follower with no paper book to copy
  | "over-committed" // allowances promise more than the broker holds
  | "run"            // what the last run actually did
  | "ledger"         // money that already moved between strategies
  | "fill";          // an order that already executed

export type HubLine = {
  id: string;
  kind: HubLineKind;
  tone: HubTone;
  text: string;
  /**
   * A few words for the strategy's own card. Set only on lines about ONE
   * strategy: the card shows this instead of repeating the panel's full
   * sentence a few pixels lower.
   */
  short?: string;
  /** Set when the line is about one strategy — lets the card echo it. */
  portfolioId?: string;
  /** The line's fix is "run a sync for this strategy". */
  offerSync?: boolean;
};

export type HubState = {
  /** One sentence: the answer to "is anything happening?". */
  headline: string;
  tone: HubTone;
  /** Things outstanding or in progress. Empty ⇒ genuinely nothing pending. */
  lines: HubLine[];
  /** What already happened (money moves + fills), newest first. */
  recent: HubLine[];
  /** "Next scheduled run: Tue 14:00 UTC (in 18h)". */
  nextRunLabel: string;
};

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** The `live-mirror.yml` crons, in UTC hours: mirror at 14:00, reconcile 23:00. */
export const SCHEDULED_RUN_HOURS_UTC = [14, 23];

/** The next scheduled `live-mirror.yml` run strictly after `now` (weekdays). */
export function nextScheduledRun(now: Date): Date {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    for (const hour of SCHEDULED_RUN_HOURS_UTC) {
      const candidate = new Date(now.getTime());
      candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
      candidate.setUTCHours(hour, 0, 0, 0);
      const day = candidate.getUTCDay();
      if (day < 1 || day > 5) continue;
      if (candidate.getTime() > now.getTime()) return candidate;
    }
  }
  return now;
}

/** "just now" / "4 min ago" / "3h ago" / "2d ago". Past times only. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.round((now.getTime() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** "in 12 min" / "in 3h" / "in 2 days". Future times only. */
export function untilTime(target: Date, now: Date): string {
  const secs = Math.round((target.getTime() - now.getTime()) / 1000);
  if (secs <= 90) return "any moment";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/** "Tue 14:00 UTC" — the label for a scheduled run. */
export function formatRunTime(target: Date): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(target);
  const hh = String(target.getUTCHours()).padStart(2, "0");
  return `${day} ${hh}:00 UTC`;
}

/**
 * Is `now` definitely OUTSIDE US trading hours (weekend, or outside
 * 09:30–16:00 America/New_York)? Deliberately one-directional: market
 * holidays aren't modelled, so we never assert "the market is open" — a
 * holiday would make that a lie on a real-money page.
 */
export function definitelyOutsideTradingHours(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return true;
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const mins = hour * 60 + minute;
  return mins < 9 * 60 + 30 || mins >= 16 * 60;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function usd(n: number): string {
  return `$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * A `portfolio_cash_ledger.reason` in plain English. The vocabulary is fixed
 * by its writers: `live-cash-mutations.ts`, `live_cash.py`, and the
 * `fund_sleeve_in_kind` RPC (migration 084).
 */
export function describeLedger(reason: string): string {
  switch (reason) {
    case "credit":
      return "credited from spare account cash";
    case "debit":
      return "returned to spare account cash";
    case "transfer-out":
      return "moved out as cash";
    case "transfer-in":
      return "moved in as cash";
    case "fund-in-kind-out":
      return "moved out as cash + positions";
    case "fund-in-kind-in":
      return "moved in as cash + positions";
    default:
      return reason;
  }
}

/**
 * The colour that identifies a strategy everywhere it appears — bar segment,
 * legend swatch and row dot all read this, so they can never drift apart.
 *
 * Deliberately excludes BOTH green and red. Those two carry meaning on this
 * page — green is a gain, red is a loss or a refusal — and a palette that
 * spends them on identity makes "the green strategy" and "up" the same colour.
 * Identity is carried by the cool/warm accents only.
 */
const SLEEVE_COLORS = [
  "var(--color-cyan, #00F2FF)",
  "var(--color-yellow, #FFD700)",
  "#B388FF",
  "var(--color-orange, #FF9900)",
  "#5B8CFF",
];

export function sleeveColor(index: number): string {
  return SLEEVE_COLORS[index % SLEEVE_COLORS.length];
}

// ---------------------------------------------------------------------------
// The state builder
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A dispatch we've asked for but not yet seen run. */
const DISPATCH_FRESH_MS = 15 * MINUTE;
/** How long a run stays worth reporting. */
const RUN_WINDOW_MS = 24 * HOUR;
/** Off-book positions older than this have missed at least one scheduled run. */
const STUCK_MS = 48 * HOUR;
/** Below this, an off-book remainder is rounding, not work. */
const MATERIAL_USD = 1;

export function buildHubState(input: HubInput): HubState {
  const now = new Date(input.nowMs);
  const next = nextScheduledRun(now);
  const nextRunLabel = `Next scheduled run: ${formatRunTime(next)} (${untilTime(next, now)})`;

  const lines: HubLine[] = [];
  const nameOf = new Map(input.sleeves.map((s) => [s.portfolioId, s.displayName]));
  const realRuns = input.runs.filter((r) => !r.dryRun);

  // 1. A sync we asked for and haven't seen run yet.
  for (const s of input.sleeves) {
    const dispatch = realRuns.find(
      (r) =>
        r.kind === "dispatch" &&
        r.portfolioId === s.portfolioId &&
        input.nowMs - Date.parse(r.createdAt) < DISPATCH_FRESH_MS,
    );
    if (!dispatch) continue;
    const ranSince = realRuns.some(
      (r) =>
        r.kind === "run" &&
        r.portfolioId === s.portfolioId &&
        Date.parse(r.createdAt) >= Date.parse(dispatch.createdAt),
    );
    if (ranSince) continue;
    lines.push({
      id: `dispatch-${s.portfolioId}`,
      kind: "dispatch",
      tone: "working",
      portfolioId: s.portfolioId,
      short: `Sync requested ${relativeTime(dispatch.createdAt, now)} — waiting for it to start`,
      text:
        `${s.displayName}: sync requested ${relativeTime(dispatch.createdAt, now)} — ` +
        "waiting for it to start.",
    });
  }

  // 2. Positions that still owe a restructure.
  for (const s of input.sleeves) {
    if (s.offBookValue <= MATERIAL_USD) continue;
    if (s.followsPortfolioId == null) {
      lines.push({
        id: `unlinked-${s.portfolioId}`,
        kind: "unlinked",
        tone: "danger",
        portfolioId: s.portfolioId,
        short: `Holds ${usd(s.offBookValue)} but isn't linked to a strategy — nothing will trade`,
        text:
          `${s.displayName} holds ${usd(s.offBookValue)} but isn't linked to a ` +
          "strategy book — nothing will ever trade here. Pick one under Manage.",
      });
      continue;
    }
    const inherited = input.ledger.find(
      (l) => l.portfolioId === s.portfolioId && l.reason === "fund-in-kind-in",
    );
    const stuck =
      inherited != null && input.nowMs - Date.parse(inherited.createdAt) > STUCK_MS;
    const ranSinceMove = realRuns.some(
      (r) =>
        r.kind === "run" &&
        r.portfolioId === s.portfolioId &&
        r.status === "ok" &&
        (!inherited || Date.parse(r.createdAt) > Date.parse(inherited.createdAt)),
    );
    lines.push({
      id: `offbook-${s.portfolioId}`,
      kind: "offbook",
      tone: stuck ? "danger" : "warn",
      portfolioId: s.portfolioId,
      offerSync: true,
      short: stuck
        ? `${usd(s.offBookValue)} still waiting to be traded into its own picks`
        : `${usd(s.offBookValue)} waiting to be traded into its own picks`,
      text: stuck
        ? `${usd(s.offBookValue)} of ${s.displayName}'s holdings still aren't its ` +
          `own picks, ${relativeTime(inherited!.createdAt, now)}. A scheduled run ` +
          "has come and gone, so real-money trading may be switched off — a " +
          "manual Sync runs regardless."
        : `${usd(s.offBookValue)} of ${s.displayName}'s holdings aren't its own ` +
          "picks yet — they get traded into them on its next sync." +
          (ranSinceMove
            ? " The last sync couldn't place them; it retries on the next run."
            : ""),
    });
  }

  // 3. Unlinked follower with nothing off-book — still broken, quieter.
  for (const s of input.sleeves) {
    if (s.followsPortfolioId != null || s.offBookValue > MATERIAL_USD) continue;
    lines.push({
      id: `unlinked-empty-${s.portfolioId}`,
      kind: "unlinked",
      tone: "warn",
      portfolioId: s.portfolioId,
      short: "Not linked to a strategy — it will never buy anything",
      text:
        `${s.displayName} isn't linked to a strategy book, so it will never ` +
        "buy anything. Pick one under Manage.",
    });
  }

  // 4. Over-committed: allowances promise more than the broker holds.
  if (input.unallocated != null && input.unallocated < -0.01) {
    lines.push({
      id: "over-committed",
      kind: "over-committed",
      tone: "danger",
      text:
        `Your strategies are allowed to spend ${usd(input.unallocated)} more than ` +
        "the broker account holds. Lower a target before an order bounces.",
    });
  }

  // 5. What the mirror actually did, most recent first.
  const lastRun = realRuns.find(
    (r) => r.kind === "run" && input.nowMs - Date.parse(r.createdAt) < RUN_WINDOW_MS,
  );
  if (lastRun) {
    const who = lastRun.portfolioId
      ? (nameOf.get(lastRun.portfolioId) ?? lastRun.slug ?? "A strategy")
      : "The account";
    const when = relativeTime(lastRun.createdAt, now);
    if (lastRun.status === "drift_refused") {
      lines.push({
        id: `run-${lastRun.createdAt}`,
        kind: "run",
        tone: "danger",
        portfolioId: lastRun.portfolioId ?? undefined,
        text:
          `${who}: the last sync refused to trade ${when} — our records disagree ` +
          "with the broker. That needs reconciling before it will trade again.",
      });
    } else if (lastRun.status === "market_closed") {
      lines.push({
        id: `run-${lastRun.createdAt}`,
        kind: "run",
        tone: "muted",
        portfolioId: lastRun.portfolioId ?? undefined,
        text: `${who}: a sync ran ${when} while the US market was shut, so nothing traded.`,
      });
    } else if (lastRun.status === "ok" && lastRun.placed === 0 && lastRun.orders === 0) {
      lines.push({
        id: `run-${lastRun.createdAt}`,
        kind: "run",
        tone: "muted",
        portfolioId: lastRun.portfolioId ?? undefined,
        text: `${who}: a sync ran ${when} — nothing to do, the live book already matched.`,
      });
    } else if (lastRun.status === "ok") {
      lines.push({
        id: `run-${lastRun.createdAt}`,
        kind: "run",
        tone: "good",
        portfolioId: lastRun.portfolioId ?? undefined,
        text: `${who}: a sync ran ${when} and placed ${lastRun.placed} order${lastRun.placed === 1 ? "" : "s"}.`,
      });
    }
  }

  // What already happened — the answer to "did my split go through?".
  const recent: HubLine[] = [];
  for (const l of input.ledger.slice(0, 3)) {
    const sign = l.deltaUsd >= 0 ? "+" : "−";
    recent.push({
      id: `ledger-${l.id}`,
      kind: "ledger",
      tone: "muted",
      portfolioId: l.portfolioId,
      text:
        `${sign}${usd(l.deltaUsd)} ${nameOf.get(l.portfolioId) ?? l.portfolioSlug} · ` +
        `${describeLedger(l.reason)} · ${relativeTime(l.createdAt, now)}`,
    });
  }
  for (const f of input.fills.slice(0, 3)) {
    recent.push({
      id: `fill-${f.id}`,
      kind: "fill",
      tone: "muted",
      portfolioId: f.portfolioId,
      text:
        `${f.side === "sell" ? "Sold" : "Bought"} ${trimQty(f.qty)} ${f.ticker} at ` +
        `${usd(f.price)} · ${nameOf.get(f.portfolioId) ?? "live"} · ` +
        `${relativeTime(f.executedAt, now)}`,
    });
  }

  // The headline. A never-funded sleeve with no history is the case the old UI
  // could not express at all — silence read as "something is pending".
  const neverFunded = input.sleeves.filter(
    (s) => !s.everFunded && s.allowance + s.holdingsValue < 0.01,
  );
  const worst = worstTone(lines);
  let headline: string;
  if (lines.length === 0 && input.ledger.length === 0 && neverFunded.length > 0) {
    headline =
      neverFunded.length === 1
        ? `Nothing pending. ${neverFunded[0].displayName} has never been funded — ` +
          "no money has ever moved into it. Set its target below and apply."
        : "Nothing pending. No money has ever moved between your strategies — " +
          "set their targets below and apply.";
  } else if (lines.length === 0) {
    headline = "Nothing pending. No money is in transit and no orders are waiting.";
  } else if (worst === "working") {
    headline = "A sync is on its way.";
  } else if (worst === "muted" || worst === "good") {
    headline = "Nothing pending right now.";
  } else if (worst === "warn") {
    headline = "One thing is still to happen.";
  } else {
    headline = "Something needs you.";
  }

  return {
    headline,
    tone: lines.length === 0 ? "good" : worst,
    lines,
    recent,
    nextRunLabel,
  };
}

const TONE_RANK: Record<HubTone, number> = {
  danger: 5,
  warn: 4,
  working: 3,
  good: 2,
  muted: 1,
};

function worstTone(lines: HubLine[]): HubTone {
  let best: HubTone = "good";
  for (const l of lines) {
    if (TONE_RANK[l.tone] > TONE_RANK[best]) best = l.tone;
  }
  return best;
}

/** 4.0000 → "4", 4.2500 → "4.25". */
function trimQty(qty: number): string {
  return String(Math.round(qty * 10000) / 10000);
}
