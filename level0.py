"""
level0.py — the contract Level 0 exposes upward (spec §9).

A thin, read-only query interface over the strategy-neutral fact store. It is
the single seam every visible surface reads through, so none of them touch the
raw tables directly:

  * the SCREENER sources candidates from the Tier 1 universe and runs its own
    `filters + weights` against the assembled facts,
  * the COMPANY PAGE reads one ticker's facts + the distribution stats for its
    percentile strips,
  * AGENTS / LENSES source candidates and compute their own signals.

Everything returned is timestamped (price as-of, data as-of) for
zero-hallucination — see the `as_of` block on each payload. This layer holds
NO strategy: it returns facts and distributions; callers decide what to do
with them.
"""

import logging
from datetime import datetime

from db import SupabaseDB

logger = logging.getLogger("level0")

# Identity columns returned for a Tier 1 universe listing (cheap candidate scan).
UNIVERSE_COLUMNS = (
    "ticker,name,exchange,security_type,gics_sector,gics_industry,country,"
    "share_class,status,is_tier1,addv_30d,last_close,tier1_evaluated_at"
)


class FactStore:
    """Read-only facade over the Level 0 tables (the §9 contract)."""

    def __init__(self, db: SupabaseDB | None = None):
        self.db = db or SupabaseDB()

    # ------------------------------------------------------------------
    # Universe (candidate sourcing)
    # ------------------------------------------------------------------

    def get_tier1_universe(self) -> dict:
        """The enriched/active set — identity + affordability-gate stamps.

        The screener's first pass picks candidates from here, then calls
        `get_facts` / `get_facts_bulk` for the columns it filters/weights on.
        """
        rows = [s for s in self.db.get_all_securities(columns=UNIVERSE_COLUMNS,
                                                       status="active")
                if s.get("is_tier1")]
        return {
            "as_of": datetime.utcnow().isoformat(),
            "tier": 1,
            "count": len(rows),
            "securities": rows,
        }

    # ------------------------------------------------------------------
    # Per-ticker facts (company page / agent signals)
    # ------------------------------------------------------------------

    def get_facts(self, ticker: str, price_history: bool = False,
                  fundamentals_history: bool = False) -> dict | None:
        """Assemble one ticker's facts across the Level 0 tables.

        Returns identity + latest fundamentals + latest valuation + last price
        + upcoming/recent events + estimates, each stamped with its as-of date.
        Set `price_history` / `fundamentals_history` to include the full series
        rather than just the latest point.
        """
        ticker = ticker.upper()
        security = self.db.get_security(ticker)
        if security is None:
            return None

        fundamentals = self.db.get_fundamentals(ticker, latest_only=not fundamentals_history)
        valuation = self.db.get_valuation(ticker, latest_only=True)
        prices = self.db.get_prices_daily(ticker) if price_history else []
        if prices:
            latest_price = prices[-1]
        else:
            # Cheap path — pull just the most-recent row, not the whole series.
            latest_rows = (
                self.db.client.table("prices_daily")
                .select("*")
                .eq("ticker", ticker)
                .order("date", desc=True)
                .limit(1)
                .execute()
            ).data or []
            latest_price = latest_rows[0] if latest_rows else None

        events = (
            self.db.client.table("events")
            .select("*")
            .eq("ticker", ticker)
            .order("date", desc=True)
            .limit(20)
            .execute()
        ).data or []
        estimates_rows = (
            self.db.client.table("estimates")
            .select("*")
            .eq("ticker", ticker)
            .execute()
        ).data or []

        return {
            "ticker": ticker,
            "as_of": {
                "queried_at": datetime.utcnow().isoformat(),
                "price_date": (latest_price or {}).get("date"),
                "fundamentals_period_end": fundamentals[0]["period_end"] if fundamentals else None,
                "valuation_date": valuation[0]["date"] if valuation else None,
            },
            "identity": security,
            "latest_price": latest_price,
            "fundamentals": fundamentals if fundamentals_history else (fundamentals[0] if fundamentals else None),
            "valuation": valuation[0] if valuation else None,
            "estimates": estimates_rows[0] if estimates_rows else None,
            "events": events,
            "price_history": prices if price_history else None,
        }

    def get_facts_bulk(self, tickers: list[str]) -> list[dict]:
        """Assemble facts for several tickers (screener weighting pass)."""
        out = []
        for t in tickers:
            facts = self.get_facts(t)
            if facts is not None:
                out.append(facts)
        return out

    # ------------------------------------------------------------------
    # Distribution stats (percentile strips / lens-relative percentiles)
    # ------------------------------------------------------------------

    def get_distribution(self, metric: str, sector: str = "") -> dict | None:
        """Return the precomputed distribution for one metric + scope.

        `sector=''` (default) is the universe-wide distribution; a named
        sector is that sector's distribution. Carries min/p25/p50/p75/max and
        the sample count for rendering a percentile ruler.
        """
        rows = self.db.get_metric_stats(metric=metric, sector=sector)
        if not rows:
            return None
        r = rows[0]
        return {
            "metric": metric,
            "scope": "universe" if sector == "" else f"sector:{sector}",
            "as_of": r.get("computed_on"),
            "min": r.get("min_val"),
            "p25": r.get("p25"),
            "p50": r.get("p50"),
            "p75": r.get("p75"),
            "max": r.get("max_val"),
            "n": r.get("sample_count"),
        }

    def get_all_distributions(self, sector: str = "") -> dict:
        """All metric distributions for a scope, keyed by metric."""
        rows = self.db.get_metric_stats(sector=sector)
        return {
            "as_of": datetime.utcnow().isoformat(),
            "scope": "universe" if sector == "" else f"sector:{sector}",
            "metrics": {
                r["metric"]: {
                    "min": r.get("min_val"), "p25": r.get("p25"),
                    "p50": r.get("p50"), "p75": r.get("p75"),
                    "max": r.get("max_val"), "n": r.get("sample_count"),
                }
                for r in rows
            },
        }
