import { getSupabase } from "@/lib/supabase";
import { realizedPnlByTrade, type PnlTrade } from "@/lib/realized-pnl";
import { markFiring } from "@/lib/portfolio-export";
import { getCurrentSignalFacts } from "@/lib/theses-query";
import type {
  ExportClosed,
  ExportData,
  ExportHolding,
  ExportSignal,
  ExportThesis,
  ExportTrade,
} from "@/lib/portfolio-export";
import type { Portfolio } from "@/lib/portfolios-query";
import {
  PRESETS,
  screenConfigSchema,
  screenFilterLabel,
} from "@/lib/screen/config";

/**
 * Assemble everything the review pack needs, in a handful of reads.
 *
 * Deliberately reads the FULL trade tape rather than the page's recent slice:
 * the export's whole purpose is that a reviewer sees the entire record, and a
 * pack showing the last 25 trades of 60 would let it praise a book whose
 * earlier half was the problem. Same reason it reads closed theses, not just
 * active ones.
 *
 * Caller must have already resolved visibility — this does no auth.
 */
export async function getPortfolioExportData(
  portfolio: Portfolio,
): Promise<ExportData> {
  const supabase = getSupabase();
  const pid = portfolio.id;

  const [accountRes, holdingsRes, tradesRes, thesesRes, teamRes] =
    await Promise.all([
      supabase
        .from("portfolio_accounts")
        .select("cash_usd, starting_cash, inception_date")
        .eq("portfolio_id", pid)
        .maybeSingle(),
      supabase
        .from("portfolio_holdings")
        .select("ticker, quantity, avg_cost_usd, first_bought_at, opened_by_agent_id")
        .eq("portfolio_id", pid),
      supabase
        .from("agent_trades")
        .select("id, ticker, side, quantity, price_usd, gross_usd, executed_at, note, agent_id")
        .eq("portfolio_id", pid)
        .order("executed_at", { ascending: true })
        .limit(5000),
      supabase
        .from("investment_theses")
        .select("ticker, thesis_text, extend_signals, break_signals, opened_at, status")
        .eq("portfolio_id", pid)
        .order("opened_at", { ascending: true }),
      supabase
        .from("portfolio_agents")
        .select("mandate, role, agents!inner(display_name, default_mandate)")
        .eq("portfolio_id", pid)
        .order("joined_at", { ascending: true }),
    ]);

  const account = (accountRes.data ?? {}) as {
    cash_usd?: number | string | null;
    starting_cash?: number | string | null;
    inception_date?: string | null;
  };
  const cash = Number(account.cash_usd ?? 0);
  const startingCash = Number(account.starting_cash ?? 0);

  const holdingRows = (holdingsRes.data ?? []) as {
    ticker: string;
    quantity: number | string;
    avg_cost_usd: number | string;
    first_bought_at: string | null;
    opened_by_agent_id: string | null;
  }[];

  // Prices + names from the Level 0 identity layer — the same column
  // portfolio.ts marks holdings at, so the pack can never disagree with the
  // page it was exported from.
  const tickers = [...new Set(holdingRows.map((h) => h.ticker))];
  const price = new Map<string, number>();
  const name = new Map<string, string>();
  let pricedAsOf: string | null = null;
  if (tickers.length > 0) {
    const { data } = await supabase
      .from("securities")
      .select("ticker, name, price, updated_at")
      .in("ticker", tickers);
    for (const s of (data ?? []) as {
      ticker: string;
      name: string | null;
      price: number | string | null;
      updated_at: string | null;
    }[]) {
      const px = s.price == null ? NaN : Number(s.price);
      if (Number.isFinite(px)) price.set(s.ticker, px);
      if (s.name) name.set(s.ticker, s.name);
      if (s.updated_at && (pricedAsOf == null || s.updated_at > pricedAsOf)) {
        pricedAsOf = s.updated_at;
      }
    }
  }

  // Agent display names for trade + position attribution, in one read.
  const agentIds = [
    ...new Set(
      [
        ...holdingRows.map((h) => h.opened_by_agent_id),
        ...((tradesRes.data ?? []) as { agent_id: string | null }[]).map(
          (t) => t.agent_id,
        ),
      ].filter((id): id is string => !!id),
    ),
  ];
  const agentName = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data } = await supabase
      .from("agents")
      .select("id, display_name, handle")
      .in("id", agentIds);
    for (const a of (data ?? []) as {
      id: string;
      display_name: string | null;
      handle: string | null;
    }[]) {
      agentName.set(a.id, a.display_name || a.handle || a.id);
    }
  }

  // Where each signal sits against today's facts, from the same source the
  // page's thesis gauges read. Fail-open: without it every signal renders as
  // "not checked", which is honest — the pack never claims a tripwire is quiet
  // when it does not know.
  const signalFacts = await getCurrentSignalFacts(tickers).catch((err) => {
    console.error("portfolio export: signal facts unavailable", err);
    return {} as Record<string, Record<string, number>>;
  });

  // The thesis shown per holding is the one currently in force.
  const thesisRows = (thesesRes.data ?? []) as {
    ticker: string;
    thesis_text: string | null;
    extend_signals: unknown;
    break_signals: unknown;
    opened_at: string | null;
    status: string | null;
  }[];
  const activeThesis = new Map<string, ExportThesis>();
  for (const t of thesisRows) {
    if (t.status !== "active") continue;
    activeThesis.set(t.ticker, {
      openedAt: day(t.opened_at),
      text: t.thesis_text,
      extendSignals: markFiring(signals(t.extend_signals), signalFacts[t.ticker]),
      breakSignals: markFiring(signals(t.break_signals), signalFacts[t.ticker]),
    });
  }

  const holdingsValue = holdingRows.reduce(
    (sum, h) => sum + Number(h.quantity) * (price.get(h.ticker) ?? 0),
    0,
  );
  const totalValue = holdingsValue + cash;

  const holdings: ExportHolding[] = holdingRows
    .map((h) => {
      const shares = Number(h.quantity);
      const avgCost = Number(h.avg_cost_usd);
      const px = price.get(h.ticker) ?? null;
      const marketValue = shares * (px ?? 0);
      const cost = shares * avgCost;
      return {
        ticker: h.ticker,
        name: name.get(h.ticker) ?? null,
        shares,
        avgCost,
        price: px,
        marketValue,
        weightPct: totalValue > 0 ? (marketValue / totalValue) * 100 : 0,
        unrealisedUsd: px == null ? 0 : marketValue - cost,
        unrealisedPct: px == null || cost <= 0 ? null : (marketValue / cost - 1) * 100,
        firstBoughtAt: day(h.first_bought_at),
        openedBy: h.opened_by_agent_id
          ? (agentName.get(h.opened_by_agent_id) ?? null)
          : null,
        thesis: activeThesis.get(h.ticker) ?? null,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  // Trades: newest first for reading, but P&L is reconstructed over the
  // chronological tape (a sell's basis depends on buys before it).
  const tradeRows = (tradesRes.data ?? []) as {
    id: string;
    ticker: string;
    side: string;
    quantity: number | string;
    price_usd: number | string;
    gross_usd: number | string | null;
    executed_at: string;
    note: string | null;
    agent_id: string | null;
  }[];
  const pnl = realizedPnlByTrade(
    tradeRows.map(
      (t): PnlTrade => ({
        id: t.id,
        ticker: t.ticker,
        side: t.side === "sell" ? "sell" : "buy",
        quantity: Number(t.quantity),
        price_usd: Number(t.price_usd),
        executed_at: t.executed_at,
      }),
    ),
  );
  const trades: ExportTrade[] = [...tradeRows].reverse().map((t) => ({
    executedAt: day(t.executed_at) ?? t.executed_at,
    ticker: t.ticker,
    side: t.side,
    quantity: Number(t.quantity),
    price: Number(t.price_usd),
    grossUsd: Number(t.gross_usd ?? Number(t.quantity) * Number(t.price_usd)),
    agent: t.agent_id ? (agentName.get(t.agent_id) ?? null) : null,
    rationale: t.note,
    realisedUsd: pnl.get(t.id)?.usd ?? null,
  }));

  // Closed = sold out entirely. Realised totals come from the same
  // reconstruction, so the tape and this table can never disagree.
  const held = new Set(holdingRows.map((h) => h.ticker));
  const closedByTicker = new Map<string, ExportClosed>();
  for (const t of tradeRows) {
    if (t.side !== "sell" || held.has(t.ticker)) continue;
    const realised = pnl.get(t.id)?.usd ?? 0;
    const prev = closedByTicker.get(t.ticker);
    closedByTicker.set(t.ticker, {
      ticker: t.ticker,
      realisedUsd: (prev?.realisedUsd ?? 0) + realised,
      lastSoldAt: day(t.executed_at),
    });
  }

  // PostgREST types an embed as an array even for a to-one relationship, and
  // returns it either way depending on the join, so normalise both shapes.
  type EmbeddedAgent = {
    display_name: string | null;
    default_mandate: string | null;
  };
  const team = ((teamRes.data ?? []) as unknown as {
    mandate: string | null;
    role: string | null;
    agents: EmbeddedAgent | EmbeddedAgent[] | null;
  }[]).map((m) => {
    const agent = Array.isArray(m.agents) ? (m.agents[0] ?? null) : m.agents;
    return {
      name: agent?.display_name ?? "Agent",
      role: m.role,
      brief: m.mandate ?? agent?.default_mandate ?? null,
    };
  });

  return {
    name: portfolio.display_name,
    slug: portfolio.slug,
    mandate: portfolio.description ?? null,
    isPublic: !!portfolio.is_public,
    generatedAt: new Date().toISOString(),
    pricedAsOf: day(pricedAsOf),
    totalValue,
    cash,
    startingCash,
    returnPct:
      startingCash > 0 ? (totalValue / startingCash - 1) * 100 : null,
    inceptionDate: day(account.inception_date ?? null),
    holdings,
    trades,
    closed: [...closedByTicker.values()].sort(
      (a, b) => a.realisedUsd - b.realisedUsd,
    ),
    team,
    universe: universeFrom(portfolio.screen_config),
    sellDiscipline:
      (portfolio as { thesis_policy?: Record<string, unknown> }).thesis_policy ??
      null,
    cashReserve:
      (portfolio as { cash_policy?: Record<string, unknown> }).cash_policy ??
      null,
  };
}

/**
 * The portfolio's screen, described in the owner's own vocabulary.
 *
 * Parsed through `screenConfigSchema` rather than read raw, so the pack shows
 * the config the AGENTS actually run — defaults filled in the same way they
 * are at rank time. A stored config missing `topN` really does cap at 40; a
 * pack that omitted it would let a reviewer assume the whole screen is in play.
 *
 * Filter labels come from `screenFilterLabel`, the same function that renders
 * the chips on the Universe tab, so the two can never drift into describing
 * one screen two ways.
 */
function universeFrom(raw: Record<string, unknown> | null) {
  if (!raw) return null;
  const parsed = screenConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("portfolio export: unparseable screen_config", parsed.error);
    return null;
  }
  const cfg = parsed.data;
  const preset = cfg.preset ? PRESETS[cfg.preset] : undefined;
  return {
    presetLabel: preset?.label ?? (cfg.preset ? cfg.preset : "Custom"),
    brief: cfg.brief ?? preset?.description ?? null,
    filters: cfg.filters.map((f) => screenFilterLabel(f)),
    weights: cfg.weights as unknown as Record<string, number>,
    topN: cfg.topN,
    aiBudget: cfg.aiBudget,
    hideRejected: cfg.hideRejected,
  };
}

function day(iso: string | null | undefined): string | null {
  return iso ? String(iso).slice(0, 10) : null;
}

/** Signals are free-form JSONB; keep only well-formed ones. */
function signals(raw: unknown): ExportSignal[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (s): s is Record<string, unknown> =>
        !!s && typeof s === "object" && "field" in s && "op" in s,
    )
    .map((s) => ({
      field: String(s.field),
      op: String(s.op),
      value: (s.value as number | string) ?? "",
      description: (s.description as string | null) ?? null,
    }));
}
