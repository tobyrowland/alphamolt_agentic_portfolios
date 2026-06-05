/**
 * Level 0-backed equity reads for the public REST API (/api/v1/equities +
 * /equities/{ticker}) and the MCP equity tools.
 *
 * The legacy `companies` table (curated TradingView growth screen, ~1k names,
 * mega-caps excluded) used to back these surfaces — which is why NVDA/AAPL/MSFT
 * 404'd and the count capped near 1,029. This module reads the real universe
 * instead: every active Tier 1 security (~3.2k liquid US equities incl.
 * mega-caps) with latest fundamentals / valuation / price, via the
 * `api_universe_facts()` RPC (migration 043).
 *
 * The full set (~3.2k rows) is loaded once and held in a 5-minute process cache
 * — the same pattern the screener uses (see web/lib/screen/query.ts) — so list
 * / detail / search are in-memory filters over a single cached snapshot rather
 * than a Postgres round-trip each.
 */

import { getSupabase } from "@/lib/supabase";

export interface Level0Equity {
  ticker: string;
  company_name: string | null;
  exchange: string | null;
  security_type: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  /** Tier 0 listing status — 'active' (delisted names are excluded here). */
  status: string | null;
  ipo_date: string | null;
  is_tier1: boolean;
  price: number | null;
  price_asof: string | null;
  rev_growth_ttm_pct: number | null;
  rev_growth_qoq_pct: number | null;
  rev_cagr_pct: number | null;
  gross_margin_pct: number | null;
  operating_margin_pct: number | null;
  net_margin_pct: number | null;
  fcf_margin_pct: number | null;
  rule_of_40: number | null;
  eps_only: number | null;
  /** period_end of the latest fundamentals row (null if not yet enriched). */
  fundamentals_asof: string | null;
  ps_now: number | null;
  ps_median_12m: number | null;
  ps_high_52w: number | null;
  ps_low_52w: number | null;
  ps_pct_of_ath: number | null;
  valuation_asof: string | null;
  /** Trailing 52-week price return, % (raw, not vs SPY). */
  ret_52w: number | null;
  /** Folded AI verdict: true = ✅, false = ❌, null = no eval. */
  bull: boolean | null;
  bear: boolean | null;
}

export interface Level0ListFilters {
  status?: string | null;
  sector?: string | null;
  country?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface Level0ListResult {
  equities: Level0Equity[];
  /** Rows returned in this page. */
  count: number;
  /** Total rows matching the filters (across all pages). */
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 1000;
// The full Tier 1 universe is ~3.2k, so allow a single call to fetch all of it.
export const MAX_LIMIT = 5000;

const PAGE = 1000;
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; data: Level0Equity[] } | null = null;
let inflight: Promise<Level0Equity[]> | null = null;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r: Record<string, unknown>): Level0Equity {
  return {
    ticker: r.ticker as string,
    company_name: (r.company_name as string) ?? null,
    exchange: (r.exchange as string) ?? null,
    security_type: (r.security_type as string) ?? null,
    sector: (r.sector as string) ?? null,
    industry: (r.industry as string) ?? null,
    country: (r.country as string) ?? null,
    status: (r.status as string) ?? null,
    ipo_date: (r.ipo_date as string) ?? null,
    is_tier1: Boolean(r.is_tier1),
    price: num(r.price),
    price_asof: (r.price_asof as string) ?? null,
    rev_growth_ttm_pct: num(r.rev_growth_ttm_pct),
    rev_growth_qoq_pct: num(r.rev_growth_qoq_pct),
    rev_cagr_pct: num(r.rev_cagr_pct),
    gross_margin_pct: num(r.gross_margin_pct),
    operating_margin_pct: num(r.operating_margin_pct),
    net_margin_pct: num(r.net_margin_pct),
    fcf_margin_pct: num(r.fcf_margin_pct),
    rule_of_40: num(r.rule_of_40),
    eps_only: num(r.eps_only),
    fundamentals_asof: (r.fundamentals_asof as string) ?? null,
    ps_now: num(r.ps_now),
    ps_median_12m: num(r.ps_median_12m),
    ps_high_52w: num(r.ps_high_52w),
    ps_low_52w: num(r.ps_low_52w),
    ps_pct_of_ath: num(r.ps_pct_of_ath),
    valuation_asof: (r.valuation_asof as string) ?? null,
    ret_52w: num(r.ret_52w),
    bull: (r.bull as boolean | null) ?? null,
    bear: (r.bear as boolean | null) ?? null,
  };
}

async function fetchUniverse(): Promise<Level0Equity[]> {
  const supabase = getSupabase();
  const rows: Record<string, unknown>[] = [];
  // ~3.2k rows = 4 PostgREST pages.
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .rpc("api_universe_facts")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) {
      console.error("api_universe_facts failed:", error.message);
      break;
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows.map(mapRow);
}

/** Cached full-universe load — fresh within TTL, concurrent calls share a fetch. */
export async function loadUniverse(): Promise<Level0Equity[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await fetchUniverse();
      if (data.length) cache = { at: Date.now(), data };
      return data.length ? data : (cache?.data ?? []);
    } catch (err) {
      console.error("loadUniverse failed:", err);
      return cache?.data ?? [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function clampLimit(limit?: number | null): number {
  return Math.min(Math.max(Number(limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export async function listEquitiesL0(
  filters: Level0ListFilters = {},
): Promise<Level0ListResult> {
  const limit = clampLimit(filters.limit);
  const offset = Math.max(Number(filters.offset ?? 0) || 0, 0);

  let rows = await loadUniverse();
  if (filters.status) {
    const s = filters.status.toLowerCase();
    rows = rows.filter((r) => (r.status ?? "").toLowerCase().includes(s));
  }
  if (filters.sector) {
    rows = rows.filter((r) => r.sector === filters.sector);
  }
  if (filters.country) {
    rows = rows.filter((r) => r.country === filters.country);
  }

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  return { equities: page, count: page.length, total, limit, offset };
}

export async function getEquityL0(ticker: string): Promise<Level0Equity | null> {
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return null;
  const rows = await loadUniverse();
  return rows.find((r) => r.ticker.toUpperCase() === normalized) ?? null;
}

export async function searchEquitiesL0(
  query: string,
  limit = 25,
): Promise<Level0Equity[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const cap = Math.min(Math.max(limit, 1), 100);
  const rows = await loadUniverse();
  return rows
    .filter(
      (r) =>
        r.ticker.toLowerCase().includes(q) ||
        (r.company_name ?? "").toLowerCase().includes(q),
    )
    .slice(0, cap);
}
