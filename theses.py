"""Investment-thesis framework — shared helpers.

When an agent buys an equity, ``PortfolioManager.buy()`` /
``buy_atomic()`` call ``record_thesis()`` here so the system captures a
durable record of the trade. Two tiers:

* **Snapshot** (always populated) — a frozen JSONB capture of the
  equity's state at buy time. Shape mirrors the ``extended`` tier of
  ``build_universe_snapshot.py`` (fundamentals + valuation + momentum
  + narrative). See ``build_snapshot``.

* **Thesis text + signals** (optional, agent-supplied) — narrative and
  machine-checkable extend/break signals. NULL when the buy call
  passed no ``thesis`` kwarg.

Lifecycle: ``active`` (default) → ``broken`` / ``improved`` /
``superseded`` / ``closed`` (terminal). ``superseded`` flows
automatically when the same agent buys the same ticker again;
``closed`` flows when ``close_theses_for_position`` is called after
a full position exit. ``broken`` / ``improved`` are caller-managed —
``check_thesis`` is read-only and returns a verdict; agents that want
to persist that verdict call ``mark_thesis_status``.

Signal operators supported by ``check_thesis``:

    >, >=, <, <=, ==, !=        — current vs static value
    change_pct_lt, change_pct_gt — current vs snapshot, percentage delta

The change_pct variants compare current vs the value captured in the
snapshot. ``{"op": "change_pct_lt", "value": -5}`` means *"current is
more than 5 percentage points below the snapshot value"* (i.e. a
collapse). Use the regular comparison operators for static thresholds.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("theses")


# Fields captured into the ``snapshot`` JSONB at buy time. Mirrors the
# ``extended`` tier of build_universe_snapshot.py (fundamentals +
# valuation + momentum + narrative + a few audit fields).
_SNAPSHOT_FIELDS: tuple[str, ...] = (
    # Identity / overview
    "ticker", "company_name", "country", "sector",
    # Fundamentals (extended tier)
    "rating", "r40_score", "rule_of_40",
    "rev_growth_ttm_pct", "rev_growth_qoq_pct", "rev_cagr_pct",
    "rev_consistency_score",
    "gross_margin_pct", "operating_margin_pct", "net_margin_pct",
    "net_margin_yoy_pct", "fcf_margin_pct",
    "opex_pct_revenue", "sm_rd_pct_revenue",
    "eps_only", "eps_yoy_pct", "qrtrs_to_profitability",
    "gm_trend",
    # Valuation
    "price", "ps_now", "price_pct_of_52w_high",
    # Momentum
    "perf_52w_vs_spy", "composite_score",
    # Narrative
    "short_outlook", "key_risks", "full_outlook", "bull_eval", "bear_eval",
    "status",
    # Quality flags + audit
    "flags", "ai_analyzed_at",
)


def build_snapshot(db, ticker: str) -> dict:
    """Read the latest equity state and return the dict for the
    ``snapshot`` JSONB column.

    Returns a dict containing exactly the fields in ``_SNAPSHOT_FIELDS``
    (missing fields become None). Raises ``ValueError`` if the ticker
    isn't in ``companies``.
    """
    company = db.get_company(ticker)
    if not company:
        raise ValueError(f"no companies row for {ticker}")
    return {k: company.get(k) for k in _SNAPSHOT_FIELDS}


def record_thesis(
    db,
    *,
    agent_id: str,
    ticker: str,
    portfolio_id: Optional[str] = None,
    trade_id: Optional[int] = None,
    thesis_text: Optional[str] = None,
    extend_signals: Optional[list[dict]] = None,
    break_signals: Optional[list[dict]] = None,
) -> int:
    """Insert an investment_theses row for a freshly-executed BUY.

    Always captures the snapshot. Marks any prior ``active`` row for
    the same (portfolio_id, ticker) — falling back to (agent_id, ticker)
    when portfolio_id is None — as ``superseded``. Returns the new
    thesis id.

    ``source='agent'`` when any of thesis_text / extend_signals /
    break_signals is provided; otherwise ``source='auto'``.
    """
    snapshot = build_snapshot(db, ticker)

    # Mark any prior active thesis for this portfolio+ticker as superseded.
    # During the 1:1 shim period, portfolio_id == agent_id; queries on either
    # column hit the same rows. We prefer portfolio_id when available since
    # that's the forward-facing key — multi-agent portfolios will share one
    # thesis lineage per ticker across all member agents.
    supersede_match = {"ticker": ticker, "status": "active"}
    if portfolio_id is not None:
        supersede_match["portfolio_id"] = portfolio_id
    else:
        supersede_match["agent_id"] = agent_id
    db.client.table("investment_theses").update(
        {"status": "superseded", "status_changed_at": "now()"}
    ).match(supersede_match).execute()

    source = "agent" if (
        thesis_text or extend_signals or break_signals
    ) else "auto"

    row = {
        "agent_id": agent_id,
        "portfolio_id": portfolio_id if portfolio_id is not None else agent_id,
        "ticker": ticker,
        "trade_id": trade_id,
        "snapshot": snapshot,
        "thesis_text": thesis_text,
        "extend_signals": extend_signals,
        "break_signals": break_signals,
        "source": source,
        "status": "active",
    }
    resp = db.client.table("investment_theses").insert(row).execute()
    inserted = (resp.data or [{}])[0]
    new_id = inserted.get("id")
    logger.info(
        "thesis %s recorded: agent=%s portfolio=%s ticker=%s source=%s trade_id=%s",
        new_id,
        agent_id[:8] if agent_id else "?",
        (portfolio_id or agent_id)[:8] if (portfolio_id or agent_id) else "?",
        ticker, source, trade_id,
    )
    return new_id


def close_theses_for_position(
    db, *, agent_id: str, ticker: str, portfolio_id: Optional[str] = None,
) -> int:
    """Flip all non-closed theses for a position to ``closed``.

    Keys on ``portfolio_id`` when provided (forward-facing), else
    ``agent_id`` (legacy). Identical during the 1:1 shim period.

    Called from ``PortfolioManager.sell`` after a sell zeros out the
    holding. Idempotent — if there are no matching rows (e.g. older
    positions opened before this migration landed), it's a no-op.

    Returns the number of rows updated.
    """
    match: dict[str, str] = {"ticker": ticker}
    if portfolio_id is not None:
        match["portfolio_id"] = portfolio_id
    else:
        match["agent_id"] = agent_id
    resp = (
        db.client.table("investment_theses")
        .update({
            "status": "closed",
            "status_changed_at": "now()",
            "closed_at": "now()",
        })
        .match(match)
        .neq("status", "closed")
        .execute()
    )
    rows = resp.data or []
    if rows:
        logger.info(
            "closed %d theses for portfolio=%s ticker=%s",
            len(rows),
            (portfolio_id or agent_id)[:8] if (portfolio_id or agent_id) else "?",
            ticker,
        )
    return len(rows)


# ---------------------------------------------------------------------------
# Maintenance check — pure read, no side effects
# ---------------------------------------------------------------------------


def _coerce_number(v: Any) -> Optional[float]:
    """Best-effort float conversion. None / em-dash / unparseable → None."""
    if v is None or v == "—":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


_STATIC_OPS = {
    ">":  lambda c, t: c >  t,
    ">=": lambda c, t: c >= t,
    "<":  lambda c, t: c <  t,
    "<=": lambda c, t: c <= t,
    "==": lambda c, t: c == t,
    "!=": lambda c, t: c != t,
}


def _evaluate_signal(signal: dict, snapshot: dict, current: dict) -> bool:
    """Return True if the signal is triggered, False otherwise.

    A signal is a dict ``{field, op, value, description?}``. Unknown
    operators, missing fields, or non-numeric values all return False
    (a malformed or unevaluable signal is treated as not-yet-triggered
    — conservative, agents see no false positives).
    """
    field = signal.get("field")
    op = signal.get("op")
    threshold = signal.get("value")
    if not field or not op:
        return False
    current_value = _coerce_number(current.get(field))
    if current_value is None:
        return False
    if op in _STATIC_OPS:
        threshold_num = _coerce_number(threshold)
        if threshold_num is None:
            return False
        return _STATIC_OPS[op](current_value, threshold_num)
    if op in ("change_pct_lt", "change_pct_gt"):
        snapshot_value = _coerce_number(snapshot.get(field))
        threshold_num = _coerce_number(threshold)
        if snapshot_value is None or threshold_num is None:
            return False
        # Percentage-point delta (current - snapshot), not relative %
        delta_pp = current_value - snapshot_value
        if op == "change_pct_lt":
            return delta_pp < threshold_num
        return delta_pp > threshold_num
    return False


def check_thesis(db, thesis_id: int) -> dict:
    """Compare a thesis's snapshot + signals against current state.

    Pure read — does NOT mutate the row. Caller decides what to do
    with the verdict (e.g. call ``mark_thesis_status`` to persist).

    Returns::

        {
          "verdict": "active" | "broken" | "improved",
          "broken_signals":           [<signal>, ...],
          "confirmed_extend_signals": [<signal>, ...],
          "delta": {<field>: {"snapshot": v, "current": v}, ...},
        }

    Precedence: any triggered break_signal → ``"broken"``; else any
    triggered extend_signal → ``"improved"``; else ``"active"``.
    For ``source='auto'`` rows with no signals the verdict is always
    ``"active"`` — the snapshot delta is still computed so callers can
    inspect drift.
    """
    resp = (
        db.client.table("investment_theses")
        .select("*")
        .eq("id", thesis_id)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        raise ValueError(f"no investment_theses row with id={thesis_id}")
    thesis = rows[0]

    ticker = thesis["ticker"]
    snapshot = thesis.get("snapshot") or {}
    current_row = db.get_company(ticker) or {}

    break_signals = thesis.get("break_signals") or []
    extend_signals = thesis.get("extend_signals") or []

    triggered_breaks = [
        s for s in break_signals if _evaluate_signal(s, snapshot, current_row)
    ]
    triggered_extends = [
        s for s in extend_signals if _evaluate_signal(s, snapshot, current_row)
    ]

    if triggered_breaks:
        verdict = "broken"
    elif triggered_extends:
        verdict = "improved"
    else:
        verdict = "active"

    # Snapshot delta — useful even when there are no signals.
    delta = {}
    for field in _SNAPSHOT_FIELDS:
        s_val = snapshot.get(field)
        c_val = current_row.get(field)
        if s_val != c_val:
            delta[field] = {"snapshot": s_val, "current": c_val}

    return {
        "verdict": verdict,
        "broken_signals": triggered_breaks,
        "confirmed_extend_signals": triggered_extends,
        "delta": delta,
    }


def mark_thesis_status(
    db, thesis_id: int, *, status: str, reason: Optional[str] = None,
) -> None:
    """Persist a status change. Optional — callers can also rely on
    ``check_thesis`` as a read-only oracle without ever writing back.

    ``status`` must be one of ``active``, ``broken``, ``improved``,
    ``superseded``, ``closed``. ``reason`` is logged but not stored
    (no column for it yet — add later if needed).
    """
    valid = {"active", "broken", "improved", "superseded", "closed"}
    if status not in valid:
        raise ValueError(f"status must be one of {valid}, got {status!r}")
    fields = {"status": status, "status_changed_at": "now()"}
    if status == "closed":
        fields["closed_at"] = "now()"
    db.client.table("investment_theses").update(fields).match(
        {"id": thesis_id}
    ).execute()
    if reason:
        logger.info("thesis %s → %s (%s)", thesis_id, status, reason)
    else:
        logger.info("thesis %s → %s", thesis_id, status)
