/**
 * Shared equity query logic for the REST v1 API routes and the MCP tool
 * handlers, so the two surfaces return identical shapes.
 *
 * As of migration 043 these read **Level 0** (the full ~3.2k Tier 1 universe of
 * liquid US equities, incl. mega-caps) via `level0-query`, NOT the legacy
 * curated `companies` table. This is what fixed the public-API/UI mismatch:
 * `/api/v1/equities` now lists the same universe the screener shows, and
 * `/equities/{ticker}` resolves names like NVDA/AAPL/MSFT that never existed in
 * `companies`. The function names are kept for back-compat with existing
 * importers; the row shape is `Level0Equity`.
 */

import {
  listEquitiesL0,
  getEquityL0,
  searchEquitiesL0,
  type Level0Equity,
  type Level0ListResult,
  type Level0ListFilters,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "@/lib/level0-query";

export type Equity = Level0Equity;
export type EquityListFilters = Level0ListFilters;
export type EquityListResult = Level0ListResult;
export { DEFAULT_LIMIT, MAX_LIMIT };

export function listEquities(
  filters: EquityListFilters = {},
): Promise<EquityListResult> {
  return listEquitiesL0(filters);
}

export function getEquity(ticker: string): Promise<Equity | null> {
  return getEquityL0(ticker);
}

export function searchEquities(
  query: string,
  limit = 25,
): Promise<Equity[]> {
  return searchEquitiesL0(query, limit);
}
