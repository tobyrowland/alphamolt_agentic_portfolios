"""
Shared Supabase database access layer.

Replaces the duplicated Google Sheets read/write code across all pipeline
scripts with a single module backed by Supabase (PostgreSQL).

Environment variables:
    SUPABASE_URL         — Supabase project URL
    SUPABASE_SERVICE_KEY — Service-role key (bypasses RLS)
"""

import json
import math
import os
import re
from datetime import date, timedelta

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

NULL_VALUE = "\u2014"  # em-dash — consistent placeholder for missing data


class SupabaseDB:
    """Shared database access layer for all pipeline scripts."""

    def __init__(self):
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY env vars must be set"
            )
        # Log connection info for debugging (mask most of the key)
        import logging
        _log = logging.getLogger("db")
        _log.info("Connecting to Supabase: url=%s key=%s...%s",
                   url, key[:8], key[-4:])
        self.client: Client = create_client(url, key)

    # ------------------------------------------------------------------
    # Companies (AI Analysis)
    # ------------------------------------------------------------------

    def get_all_companies(self, columns: str = "*") -> list[dict]:
        """Return all rows from the companies table."""
        resp = self.client.table("companies").select(columns).execute()
        return resp.data

    def get_company(self, ticker: str) -> dict | None:
        """Return a single company row, or None."""
        resp = (
            self.client.table("companies")
            .select("*")
            .eq("ticker", ticker)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_all_tickers(self) -> set[str]:
        """Return the set of all ticker symbols in the companies table."""
        resp = self.client.table("companies").select("ticker").execute()
        return {row["ticker"] for row in resp.data}

    def get_stale_companies(self, date_column: str, days: int) -> list[dict]:
        """Return companies where `date_column` is older than `days` or NULL."""
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        # Supabase doesn't support OR with is_.null in a single filter chain,
        # so we fetch all and filter in Python for reliability.
        resp = self.client.table("companies").select("*").execute()
        results = []
        for row in resp.data:
            val = row.get(date_column)
            if val is None or val == "" or val < cutoff:
                results.append(row)
        return results

    def upsert_company(self, ticker: str, data: dict) -> None:
        """Insert or update a single company row."""
        data["ticker"] = ticker
        self._sanitize(data)
        self.client.table("companies").upsert(data).execute()

    def upsert_companies_batch(self, rows: list[dict]) -> None:
        """Insert or update multiple company rows."""
        for row in rows:
            self._sanitize(row)
        if rows:
            self.client.table("companies").upsert(rows).execute()

    def bulk_upsert_company_prices(self, rows: list[dict]) -> None:
        """Write only the live price columns (price, price_asof) to many
        company rows in a single batch.

        Used by intraday_prices.py — the 15-min refresher must not touch
        fundamentals / R40 / AI narrative / sort_order / flags or any other
        column those daily jobs own. Each row must include `ticker`; any
        keys outside the allowed set are filtered out defensively so an
        accidental field can't blow away the daily-refreshed columns.
        """
        if not rows:
            return
        allowed = {"ticker", "price", "price_asof"}
        cleaned: list[dict] = []
        for row in rows:
            slim = {k: row[k] for k in row.keys() & allowed}
            if "ticker" not in slim or slim.get("price") is None:
                continue
            self._sanitize(slim)
            cleaned.append(slim)
        if cleaned:
            self.client.table("companies").upsert(cleaned).execute()

    # ------------------------------------------------------------------
    # Price-Sales
    # ------------------------------------------------------------------

    def get_all_price_sales(self) -> dict[str, dict]:
        """Return all price-sales rows keyed by ticker."""
        resp = self.client.table("price_sales").select("*").execute()
        return {row["ticker"]: row for row in resp.data}

    def get_price_sales(self, ticker: str) -> dict | None:
        """Return a single price-sales row, or None."""
        resp = (
            self.client.table("price_sales")
            .select("*")
            .eq("ticker", ticker)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def upsert_price_sales(self, ticker: str, data: dict) -> None:
        """Insert or update a price-sales row."""
        data["ticker"] = ticker
        self._sanitize(data)
        self.client.table("price_sales").upsert(data).execute()

    def upsert_price_sales_batch(self, rows: list[dict]) -> None:
        """Insert or update multiple price-sales rows."""
        for row in rows:
            self._sanitize(row)
        if rows:
            self.client.table("price_sales").upsert(rows).execute()

    # ------------------------------------------------------------------
    # Metric distribution stats (fundamentals percentile rulers)
    # ------------------------------------------------------------------

    def upsert_metric_stats_batch(self, rows: list[dict]) -> None:
        """Insert or update precomputed metric_stats rows (migration 038).

        Conflict target is the (metric, sector) primary key. Written
        nightly by score_ai_analysis.py so the /company/{ticker}
        distribution strips read precomputed percentiles instead of
        recomputing the universe distribution on every request.
        """
        for row in rows:
            self._sanitize(row)
        if rows:
            (
                self.client.table("metric_stats")
                .upsert(rows, on_conflict="metric,sector")
                .execute()
            )

    def get_metric_stats(self, metric: str | None = None,
                         sector: str | None = None) -> list[dict]:
        """Read precomputed metric_stats rows (migration 038).

        Powers the §9 query contract's distribution stats (percentile strips
        on the company page, lens-relative percentiles). `sector=''` is the
        universe-wide row; a named sector is that sector's distribution.
        """
        q = self.client.table("metric_stats").select("*")
        if metric is not None:
            q = q.eq("metric", metric)
        if sector is not None:
            q = q.eq("sector", sector)
        return q.execute().data or []

    # ------------------------------------------------------------------
    # Level 0 — strategy-neutral universe & fact store (migration 039)
    #
    # securities (Tier 0 identity) + prices_daily / fundamentals / valuation /
    # estimates / events (Tier 1 enrichment). These are FACTS only — no
    # strategy lives here. See the alphamolt Level 0 spec.
    # ------------------------------------------------------------------

    # --- securities (Tier 0) ---

    def get_security(self, ticker: str) -> dict | None:
        """Return a single securities row, or None."""
        resp = (
            self.client.table("securities")
            .select("*")
            .eq("ticker", ticker)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_all_securities(self, columns: str = "*",
                           status: str | None = None) -> list[dict]:
        """Return securities rows, optionally filtered by status.

        Paginates so the full ~5-7k-row Tier 0 universe comes back (Supabase
        caps a single select at 1000 rows).
        """
        rows: list[dict] = []
        page = 0
        page_size = 1000
        while True:
            q = self.client.table("securities").select(columns)
            if status is not None:
                q = q.eq("status", status)
            resp = q.range(page * page_size, (page + 1) * page_size - 1).execute()
            batch = resp.data or []
            rows.extend(batch)
            if len(batch) < page_size:
                break
            page += 1
        return rows

    def get_tier1_tickers(self) -> set[str]:
        """Return the set of tickers currently flagged is_tier1."""
        tickers: set[str] = set()
        page = 0
        page_size = 1000
        while True:
            resp = (
                self.client.table("securities")
                .select("ticker")
                .eq("is_tier1", True)
                .range(page * page_size, (page + 1) * page_size - 1)
                .execute()
            )
            batch = resp.data or []
            tickers.update(r["ticker"] for r in batch)
            if len(batch) < page_size:
                break
            page += 1
        return tickers

    def upsert_securities_batch(self, rows: list[dict]) -> None:
        """Insert or update many securities rows (conflict on ticker PK)."""
        for row in rows:
            self._sanitize(row)
        if rows:
            self.client.table("securities").upsert(rows).execute()

    # --- prices_daily ---

    def upsert_prices_daily_batch(self, rows: list[dict]) -> None:
        """Insert or update many prices_daily rows (conflict on ticker,date).

        Chunks large batches (a 2y backfill is ~500 rows/ticker) so a single
        request stays a sane size.
        """
        cleaned = [r for r in rows if r.get("ticker") and r.get("date")]
        for row in cleaned:
            self._sanitize(row)
        for i in range(0, len(cleaned), 1000):
            chunk = cleaned[i:i + 1000]
            (
                self.client.table("prices_daily")
                .upsert(chunk, on_conflict="ticker,date")
                .execute()
            )

    def get_prices_daily(self, ticker: str, since: str | None = None) -> list[dict]:
        """Return a ticker's daily prices ascending by date (optional since)."""
        q = self.client.table("prices_daily").select("*").eq("ticker", ticker)
        if since:
            q = q.gte("date", since)
        resp = q.order("date").execute()
        return resp.data or []

    def get_tickers_with_recent_prices(self, since: str) -> set[str]:
        """Return tickers that have a prices_daily row on/after `since`.

        Used to tell which Tier 1 names still need a 2y backfill (absent here)
        vs. just a daily increment (present here)."""
        tickers: set[str] = set()
        page = 0
        page_size = 1000
        while True:
            resp = (
                self.client.table("prices_daily")
                .select("ticker")
                .gte("date", since)
                .range(page * page_size, (page + 1) * page_size - 1)
                .execute()
            )
            batch = resp.data or []
            tickers.update(r["ticker"] for r in batch)
            if len(batch) < page_size:
                break
            page += 1
        return tickers

    def get_latest_price_date(self, ticker: str) -> str | None:
        """Return the most-recent prices_daily date for a ticker, or None."""
        resp = (
            self.client.table("prices_daily")
            .select("date")
            .eq("ticker", ticker)
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        return resp.data[0]["date"] if resp.data else None

    # --- fundamentals (history) ---

    def upsert_fundamentals_batch(self, rows: list[dict]) -> None:
        """Insert or update fundamentals rows (conflict on ticker,period_end).

        Append-only by design — each new filing is a fresh period_end row;
        existing periods are corrected in place but never collapsed.
        """
        for row in rows:
            self._sanitize(row)
        if rows:
            (
                self.client.table("fundamentals")
                .upsert(rows, on_conflict="ticker,period_end")
                .execute()
            )

    def get_fundamentals(self, ticker: str, latest_only: bool = False) -> list[dict]:
        """Return a ticker's fundamentals history (newest first).

        latest_only=True returns just the most-recent period as a 1-list.
        """
        q = (
            self.client.table("fundamentals")
            .select("*")
            .eq("ticker", ticker)
            .order("period_end", desc=True)
        )
        if latest_only:
            q = q.limit(1)
        resp = q.execute()
        return resp.data or []

    def get_fundamentals_tickers(self) -> set[str]:
        """Return the set of tickers that have at least one fundamentals row.

        Paginated — the table is one row per (ticker, period_end), so distinct
        tickers come back across pages.
        """
        tickers: set[str] = set()
        page = 0
        page_size = 1000
        while True:
            resp = (
                self.client.table("fundamentals")
                .select("ticker")
                .range(page * page_size, (page + 1) * page_size - 1)
                .execute()
            )
            batch = resp.data or []
            tickers.update(r["ticker"] for r in batch)
            if len(batch) < page_size:
                break
            page += 1
        return tickers

    # --- valuation ---

    def upsert_valuation_batch(self, rows: list[dict]) -> None:
        """Insert or update valuation rows (conflict on ticker,date)."""
        for row in rows:
            self._sanitize(row)
        if rows:
            (
                self.client.table("valuation")
                .upsert(rows, on_conflict="ticker,date")
                .execute()
            )

    def get_valuation(self, ticker: str, latest_only: bool = True) -> list[dict]:
        """Return a ticker's valuation rows (newest first)."""
        q = (
            self.client.table("valuation")
            .select("*")
            .eq("ticker", ticker)
            .order("date", desc=True)
        )
        if latest_only:
            q = q.limit(1)
        resp = q.execute()
        return resp.data or []

    def get_valuation_tickers(self) -> set[str]:
        """Return the set of tickers that have at least one valuation row."""
        tickers: set[str] = set()
        page = 0
        page_size = 1000
        while True:
            resp = (
                self.client.table("valuation")
                .select("ticker")
                .range(page * page_size, (page + 1) * page_size - 1)
                .execute()
            )
            batch = resp.data or []
            tickers.update(r["ticker"] for r in batch)
            if len(batch) < page_size:
                break
            page += 1
        return tickers

    # --- derived views ---

    def refresh_screen_facts(self) -> None:
        """Rebuild the screener's materialized facts view (migration 044).

        screen_facts_mv precomputes the per-ticker latest fundamentals /
        valuation / price the screener ranks over, so page loads read a cheap
        indexed table instead of recomputing ~3k LATERAL lookups each time.
        Call after the daily Level 0 data has settled to pick up fresh rows.
        """
        self.client.rpc("refresh_screen_facts").execute()

    # --- estimates / events ---

    def upsert_estimates_batch(self, rows: list[dict]) -> None:
        """Insert or update estimates rows (conflict on ticker PK)."""
        for row in rows:
            self._sanitize(row)
        if rows:
            self.client.table("estimates").upsert(rows).execute()

    def upsert_events_batch(self, rows: list[dict]) -> None:
        """Insert or update events rows (conflict on ticker,type,date)."""
        cleaned = [r for r in rows if r.get("ticker") and r.get("type") and r.get("date")]
        for row in cleaned:
            self._sanitize(row)
        if cleaned:
            (
                self.client.table("events")
                .upsert(cleaned, on_conflict="ticker,type,date")
                .execute()
            )

    # ------------------------------------------------------------------
    # Agents / Portfolio Manager
    # ------------------------------------------------------------------

    def get_agent_by_handle(self, handle: str) -> dict | None:
        """Return a single agents row by handle, or None."""
        resp = (
            self.client.table("agents")
            .select("*")
            .eq("handle", handle)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_agent_account(self, agent_id: str) -> dict | None:
        """Return a single agent_accounts row, or None."""
        resp = (
            self.client.table("agent_accounts")
            .select("*")
            .eq("agent_id", agent_id)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_all_agent_accounts(self) -> list[dict]:
        """Return all agent_accounts rows."""
        resp = self.client.table("agent_accounts").select("*").execute()
        return resp.data

    def upsert_agent_account(self, agent_id: str, data: dict) -> None:
        """Insert or update an agent_accounts row."""
        data["agent_id"] = agent_id
        self._sanitize(data)
        self.client.table("agent_accounts").upsert(data).execute()

    # ------------------------------------------------------------------
    # Portfolios (migration 021) — first-class entity that one or more
    # agents can operate on. During the shim period every existing
    # agent_account also has a portfolios row with the same UUID and
    # the owner agent as the sole member of portfolio_agents.
    # ------------------------------------------------------------------

    def get_portfolio_by_id(self, portfolio_id: str) -> dict | None:
        resp = (
            self.client.table("portfolios")
            .select("*")
            .eq("id", portfolio_id)
            .limit(1)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_portfolio_by_slug(self, slug: str) -> dict | None:
        resp = (
            self.client.table("portfolios")
            .select("*")
            .eq("slug", slug)
            .limit(1)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_portfolio_by_agent_id(self, agent_id: str) -> dict | None:
        """Return the portfolio this agent owns (or the first one they're a member of).

        Resolves in two steps so non-owner members still get a sensible
        default: first check `portfolios.owner_agent_id`, then fall back
        to `portfolio_agents.agent_id`. Returns None if the agent has no
        portfolio yet (typical for analyst agents).
        """
        owned = (
            self.client.table("portfolios")
            .select("*")
            .eq("owner_agent_id", agent_id)
            .limit(1)
            .execute()
        )
        if owned.data:
            return owned.data[0]
        member = (
            self.client.table("portfolio_agents")
            .select("portfolio_id")
            .eq("agent_id", agent_id)
            .limit(1)
            .execute()
        )
        if not member.data:
            return None
        return self.get_portfolio_by_id(member.data[0]["portfolio_id"])

    def get_portfolios_for_agent(self, agent_id: str) -> list[dict]:
        """Return every portfolio the agent is a member of (incl. owned).

        Used by the agent profile page. Returns rows shaped as
        ``{portfolio: portfolios_row, notes: portfolio_agents.notes,
            joined_at: portfolio_agents.joined_at}``.
        """
        memberships = (
            self.client.table("portfolio_agents")
            .select("*")
            .eq("agent_id", agent_id)
            .execute()
        )
        out: list[dict] = []
        for m in memberships.data or []:
            p = self.get_portfolio_by_id(m["portfolio_id"])
            if p:
                out.append({
                    "portfolio": p,
                    "notes": m.get("notes"),
                    "joined_at": m.get("joined_at"),
                })
        return out

    def get_portfolio_members(self, portfolio_id: str) -> list[dict]:
        """Return [{agent: agents_row, notes, joined_at}, ...] for a portfolio."""
        memberships = (
            self.client.table("portfolio_agents")
            .select("*")
            .eq("portfolio_id", portfolio_id)
            .order("joined_at")
            .execute()
        )
        out: list[dict] = []
        for m in memberships.data or []:
            agent = (
                self.client.table("agents")
                .select("*")
                .eq("id", m["agent_id"])
                .limit(1)
                .execute()
            )
            if agent.data:
                out.append({
                    "agent": agent.data[0],
                    "notes": m.get("notes"),
                    "joined_at": m.get("joined_at"),
                    # Swarm membership (migration 041): role ('buyer'|'reviewer'),
                    # free-text remit/focus, and per-member knobs (config).
                    "role": m.get("role"),
                    "remit": m.get("remit"),
                    "config": m.get("config"),
                    # Per-instance mandate override (migration 046). NULL =
                    # use the agent's default_mandate (which rides along in the
                    # agents row below). Resolved at ctx-build time in the
                    # heartbeat: override ?? agent default ?? portfolio brief.
                    "mandate": m.get("mandate"),
                    # Per-instance Run/Stop switch (migration 045). A stopped
                    # team agent stays on the roster but is skipped by the
                    # heartbeat. Default True for legacy rows / new members.
                    "enabled": m.get("enabled", True),
                    # Per-membership heartbeat clock (migration 029) — each
                    # member rebalances on its own cadence in every
                    # portfolio it joins.
                    "member_last_heartbeat_at": m.get("last_heartbeat_at"),
                })
        return out

    def create_portfolio(
        self,
        *,
        portfolio_id: str,
        slug: str,
        display_name: str,
        owner_agent_id: str,
        description: str | None = None,
    ) -> dict:
        """Insert a portfolios row (idempotent on the id)."""
        row = {
            "id": portfolio_id,
            "slug": slug,
            "display_name": display_name,
            "description": description,
            "owner_agent_id": owner_agent_id,
        }
        self._sanitize(row)
        self.client.table("portfolios").upsert(row).execute()
        return self.get_portfolio_by_id(portfolio_id)

    def add_portfolio_member(
        self,
        *,
        portfolio_id: str,
        agent_id: str,
        notes: str | None = None,
    ) -> None:
        """Add an agent to a portfolio (idempotent on the composite PK)."""
        row = {
            "portfolio_id": portfolio_id,
            "agent_id": agent_id,
            "notes": notes,
        }
        self._sanitize(row)
        self.client.table("portfolio_agents").upsert(row).execute()

    # ------------------------------------------------------------------
    # Portfolio-level trading (migration 025) — shared-pot cash + holdings
    # for human-owned portfolios. Keyed on portfolio_id, not agent_id.
    # ------------------------------------------------------------------

    def get_human_portfolios(self) -> list[dict]:
        """Every human-owned portfolio. Funded with $1M at creation."""
        resp = (
            self.client.table("portfolios")
            .select("*")
            .not_.is_("owner_user_id", "null")
            .execute()
        )
        return resp.data

    def update_portfolio_last_heartbeat(self, portfolio_id: str, ts: str) -> None:
        """Stamp portfolios.last_heartbeat_at after a portfolio rebalance."""
        (
            self.client.table("portfolios")
            .update({"last_heartbeat_at": ts})
            .eq("id", portfolio_id)
            .execute()
        )

    def update_portfolio_member_heartbeat(
        self, portfolio_id: str, agent_id: str, ts: str
    ) -> None:
        """Stamp a portfolio_agents membership's last_heartbeat_at (migration 029).

        Tracks per-(portfolio, agent) cadence so a member rebalances on its
        own heartbeat_interval_hours independently in every portfolio it
        joins — a daily curator and a weekly buyer can share one portfolio.
        """
        (
            self.client.table("portfolio_agents")
            .update({"last_heartbeat_at": ts})
            .eq("portfolio_id", portfolio_id)
            .eq("agent_id", agent_id)
            .execute()
        )

    def get_portfolio_account(self, portfolio_id: str) -> dict | None:
        """Return a single portfolio_accounts row, or None."""
        resp = (
            self.client.table("portfolio_accounts")
            .select("*")
            .eq("portfolio_id", portfolio_id)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def get_all_portfolio_accounts(self) -> list[dict]:
        """Return all portfolio_accounts rows."""
        resp = self.client.table("portfolio_accounts").select("*").execute()
        return resp.data

    def upsert_portfolio_account(self, portfolio_id: str, data: dict) -> None:
        """Insert or update a portfolio_accounts row."""
        data["portfolio_id"] = portfolio_id
        self._sanitize(data)
        self.client.table("portfolio_accounts").upsert(data).execute()

    def get_portfolio_holdings(self, portfolio_id: str) -> list[dict]:
        """Return all holdings rows for a portfolio."""
        resp = (
            self.client.table("portfolio_holdings")
            .select("*")
            .eq("portfolio_id", portfolio_id)
            .execute()
        )
        return resp.data

    def get_portfolio_holding(
        self, portfolio_id: str, ticker: str
    ) -> dict | None:
        """Return a single portfolio_holdings row, or None."""
        resp = (
            self.client.table("portfolio_holdings")
            .select("*")
            .eq("portfolio_id", portfolio_id)
            .eq("ticker", ticker)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def upsert_portfolio_holding(self, data: dict) -> None:
        """Insert or update a portfolio_holdings row. Caller sets portfolio_id+ticker."""
        self._sanitize(data)
        self.client.table("portfolio_holdings").upsert(data).execute()

    def delete_portfolio_holding(self, portfolio_id: str, ticker: str) -> None:
        """Remove a portfolio_holdings row (used when quantity reaches 0)."""
        (
            self.client.table("portfolio_holdings")
            .delete()
            .eq("portfolio_id", portfolio_id)
            .eq("ticker", ticker)
            .execute()
        )

    def get_agent_holdings(self, agent_id: str) -> list[dict]:
        """Return all holdings rows for an agent."""
        resp = (
            self.client.table("agent_holdings")
            .select("*")
            .eq("agent_id", agent_id)
            .execute()
        )
        return resp.data

    def get_agent_holding(self, agent_id: str, ticker: str) -> dict | None:
        """Return a single holdings row, or None."""
        resp = (
            self.client.table("agent_holdings")
            .select("*")
            .eq("agent_id", agent_id)
            .eq("ticker", ticker)
            .execute()
        )
        return resp.data[0] if resp.data else None

    def upsert_agent_holding(self, data: dict) -> None:
        """Insert or update an agent_holdings row. Caller must set agent_id+ticker."""
        self._sanitize(data)
        self.client.table("agent_holdings").upsert(data).execute()

    def delete_agent_holding(self, agent_id: str, ticker: str) -> None:
        """Remove an agent_holdings row (used when quantity reaches 0)."""
        (
            self.client.table("agent_holdings")
            .delete()
            .eq("agent_id", agent_id)
            .eq("ticker", ticker)
            .execute()
        )

    def insert_agent_trade(self, data: dict) -> int | None:
        """Append a row to the immutable trade journal.

        Returns the inserted row's ``id`` (BIGINT, auto-generated) so
        downstream consumers can link to the trade — e.g.
        ``investment_theses.trade_id``.
        """
        self._sanitize(data)
        resp = self.client.table("agent_trades").insert(data).execute()
        rows = resp.data or []
        return rows[0].get("id") if rows else None

    def get_recently_sold_tickers(
        self, portfolio_id: str, *, days: int = 90,
    ) -> set[str]:
        """Tickers a portfolio has sold within the last ``days`` days.

        Used by the LLM buyer (and the mechanical watchlist_buyer) to
        enforce a re-buy cooldown: once the owner or the reviewer agent
        has exited a position, the buyer is not allowed to immediately
        re-establish it. Default 90 days mirrors the user-facing rule.
        """
        from datetime import datetime, timedelta, timezone
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        resp = (
            self.client.table("agent_trades")
            .select("ticker")
            .eq("portfolio_id", portfolio_id)
            .eq("side", "sell")
            .gte("executed_at", cutoff)
            .execute()
        )
        return {
            str(r.get("ticker") or "").upper()
            for r in (resp.data or [])
            if r.get("ticker")
        }

    def get_agent_sold_tickers(
        self, portfolio_id: str, agent_id: str,
    ) -> set[str]:
        """Every ticker a specific agent has EVER sold in a portfolio (no window).

        Trade attribution stamps ``agent_trades.agent_id`` with the acting
        agent, so this is "names this agent has already acted on". Used by the
        profit-taker to enforce its trim-once-per-equity-ever rule: once it has
        banked a gain on a name it never trims that name again.
        """
        resp = (
            self.client.table("agent_trades")
            .select("ticker")
            .eq("portfolio_id", portfolio_id)
            .eq("agent_id", agent_id)
            .eq("side", "sell")
            .execute()
        )
        return {
            str(r.get("ticker") or "").upper()
            for r in (resp.data or [])
            if r.get("ticker")
        }

    def upsert_portfolio_snapshot(self, data: dict) -> None:
        """Insert or update a daily agent_portfolio_history row.

        Conflict target is the (portfolio_id, snapshot_date) primary key
        (migration 025) so both agent-owned and human-owned portfolios
        upsert correctly.
        """
        self._sanitize(data)
        (
            self.client.table("agent_portfolio_history")
            .upsert(data, on_conflict="portfolio_id,snapshot_date")
            .execute()
        )

    # ------------------------------------------------------------------
    # Swarm Consensus
    # ------------------------------------------------------------------

    def fetch_holdings_with_agent_company(self) -> list[dict]:
        """Return every agent_holdings row joined to its agent + company.

        One round-trip; the consensus aggregation runs in Python afterwards.
        Output rows are flattened: {agent_id, ticker, quantity, avg_cost_usd,
        handle, display_name, is_house_agent, company_name, current_price}.
        """
        resp = (
            self.client.table("agent_holdings")
            .select(
                "agent_id, ticker, quantity, avg_cost_usd, "
                "agents(handle, display_name, is_house_agent), "
                "companies(company_name, price)"
            )
            .execute()
        )
        out: list[dict] = []
        for r in resp.data or []:
            agent = r.get("agents") or {}
            company = r.get("companies") or {}
            out.append({
                "agent_id": r.get("agent_id"),
                "ticker": r.get("ticker"),
                "quantity": r.get("quantity"),
                "avg_cost_usd": r.get("avg_cost_usd"),
                "handle": agent.get("handle"),
                "display_name": agent.get("display_name"),
                "is_house_agent": agent.get("is_house_agent"),
                "company_name": company.get("company_name"),
                "current_price": company.get("price"),
            })
        return out

    def get_latest_consensus_top_tickers(
        self, limit: int = 5
    ) -> tuple[list[dict], str | None]:
        """Return the highest-conviction tickers from the latest snapshot.

        Joins ``companies`` for ``company_name`` so callers can disambiguate
        the ticker when classifying social posts. Used by the Bluesky
        heartbeat's equity-targeting phase.
        """
        latest = (
            self.client.table("consensus_snapshots")
            .select("snapshot_date")
            .order("snapshot_date", desc=True)
            .limit(1)
            .execute()
        )
        if not latest.data:
            return [], None
        snapshot_date = latest.data[0]["snapshot_date"]

        resp = (
            self.client.table("consensus_snapshots")
            .select(
                "rank, ticker, num_agents, total_agents, pct_agents, "
                "swarm_pnl_pct, companies(company_name)"
            )
            .eq("snapshot_date", snapshot_date)
            .order("rank", desc=False)
            .limit(limit)
            .execute()
        )
        rows: list[dict] = []
        for r in resp.data or []:
            company = r.get("companies") or {}
            rows.append({
                "rank": r.get("rank"),
                "ticker": r.get("ticker"),
                "company_name": company.get("company_name") or r.get("ticker"),
                "num_agents": r.get("num_agents"),
                "total_agents": r.get("total_agents"),
                "pct_agents": r.get("pct_agents"),
                "swarm_pnl_pct": r.get("swarm_pnl_pct"),
            })
        return rows, snapshot_date

    def replace_consensus_snapshot(
        self, snapshot_date: str, rows: list[dict]
    ) -> None:
        """Replace the consensus snapshot for a given date.

        Deletes any existing rows for snapshot_date, then inserts the new set
        in a single batch. Idempotent — safe to re-run on the same date.
        """
        (
            self.client.table("consensus_snapshots")
            .delete()
            .eq("snapshot_date", snapshot_date)
            .execute()
        )
        if not rows:
            return
        for row in rows:
            self._sanitize(row)
        self.client.table("consensus_snapshots").insert(rows).execute()

    # ------------------------------------------------------------------
    # Agent Heartbeats
    # ------------------------------------------------------------------

    def get_all_agents(self) -> list[dict]:
        """Return every row in the agents table."""
        resp = self.client.table("agents").select("*").execute()
        return resp.data

    def update_agent_last_heartbeat(self, agent_id: str, when_iso: str) -> None:
        """Mark an agent's last_heartbeat_at timestamp."""
        (
            self.client.table("agents")
            .update({"last_heartbeat_at": when_iso})
            .eq("id", agent_id)
            .execute()
        )

    def insert_agent_heartbeat(self, data: dict) -> None:
        """Append a row to the agent_heartbeats journal."""
        self._sanitize(data)
        self.client.table("agent_heartbeats").insert(data).execute()

    # ------------------------------------------------------------------
    # Portfolio watchlist (migration 027) — curated per-portfolio shortlist.
    # The owner writes source='user' rows; the watchlist_curator strategy
    # writes source='agent' rows; the watchlist_buyer strategy reads both.
    # ------------------------------------------------------------------

    def get_portfolio_watchlist(self, portfolio_id: str) -> list[dict]:
        """Return every portfolio_watchlist row for a portfolio."""
        resp = (
            self.client.table("portfolio_watchlist")
            .select("*")
            .eq("portfolio_id", portfolio_id)
            .execute()
        )
        return resp.data or []

    def replace_agent_watchlist(
        self,
        portfolio_id: str,
        agent_id: str,
        items: list[dict],
    ) -> None:
        """Replace one curator's watchlist picks for a portfolio.

        Deletes the rows this ``agent_id`` previously contributed
        (``source='agent'`` AND ``added_by_agent_id=agent_id``), then
        inserts ``items`` (each ``{ticker, rationale}``) as fresh
        ``source='agent'`` rows attributed to ``agent_id``. Other curators'
        picks and the owner's manual ``source='user'`` rows are never
        touched — so several specialist curators can each maintain their
        own slice of the same portfolio's watchlist.
        """
        (
            self.client.table("portfolio_watchlist")
            .delete()
            .eq("portfolio_id", portfolio_id)
            .eq("source", "agent")
            .eq("added_by_agent_id", agent_id)
            .execute()
        )
        rows = [
            {
                "portfolio_id": portfolio_id,
                "ticker": it["ticker"],
                "source": "agent",
                "added_by_agent_id": agent_id,
                "rationale": it.get("rationale"),
            }
            for it in items
            if it.get("ticker")
        ]
        if rows:
            for r in rows:
                self._sanitize(r)
            self.client.table("portfolio_watchlist").insert(rows).execute()

    # ------------------------------------------------------------------
    # Run Logs
    # ------------------------------------------------------------------

    def log_run(self, script_name: str, stats: dict) -> None:
        """Insert a run-log entry."""
        row = {
            "script_name": script_name,
            "run_date": date.today().isoformat(),
            **stats,
        }
        self._sanitize(row)
        self.client.table("run_logs").insert(row).execute()

    # ------------------------------------------------------------------
    # Sanitization
    # ------------------------------------------------------------------

    def _sanitize(self, data: dict) -> None:
        """Clean values before sending to Supabase (NaN, Inf, em-dash → None)."""
        for k, v in list(data.items()):
            if v is None:
                continue
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                data[k] = None
            elif v == NULL_VALUE:
                data[k] = None

    # ------------------------------------------------------------------
    # Shared utilities (consolidated from all scripts)
    # ------------------------------------------------------------------

    @staticmethod
    def safe_float(val) -> float | None:
        """Try to convert a value to float, return None on failure.

        Handles em-dash null markers, percentage signs, and NaN/Inf.
        """
        if val is None or val == "" or val == NULL_VALUE:
            return None
        try:
            cleaned = str(val).strip().rstrip("%")
            f = float(cleaned)
            if math.isnan(f) or math.isinf(f):
                return None
            return f
        except (ValueError, TypeError):
            return None

    @staticmethod
    def extract_ticker(val: str) -> str:
        """Extract ticker from a HYPERLINK formula or plain text.

        Handles both =HYPERLINK("url", "TICKER") formulas and plain strings.
        """
        val = str(val).strip()
        if not val:
            return ""
        match = re.search(r'=HYPERLINK\([^,]+,\s*"([^"]+)"\)', val)
        if match:
            return match.group(1).strip().upper()
        return val.strip().upper()
