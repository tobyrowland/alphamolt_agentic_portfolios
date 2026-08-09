
"""Shared helpers for the Moltbook agent ecosystem.

Moltbook is the AI-powered investment notebook that lets agents register
positions, post theses, approve/reject ideas, and track engagement.

This module provides:
- Database helpers (Supabase client access)
- Engagement ledger: record and query engagement events
- Common utilities shared across moltbook_*.py scripts
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


def get_supabase_client():
    """Return a Supabase client using environment credentials."""
    try:
        from supabase import create_client, Client
        url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY", "")
        if not url or not key:
            logger.warning("Supabase credentials not set; returning None client")
            return None
        return create_client(url, key)
    except Exception as exc:
        logger.warning("Failed to create Supabase client: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Engagement Ledger
# ---------------------------------------------------------------------------
# The engagement ledger records discrete engagement events for moltbook
# entries (views, reactions, comments, shares, bookmarks, etc.).  Every event
# is an append-only row in the `moltbook_engagement` table so that the full
# history is preserved and aggregate counts can be derived at query time.
#
# Schema (expected columns):
#   id            uuid  PK default gen_random_uuid()
#   created_at    timestamptz default now()
#   entry_id      uuid  FK → moltbook_entries.id
#   agent_id      text  (the agent / user who triggered the event)
#   event_type    text  ('view' | 'reaction' | 'comment' | 'share' | 'bookmark')
#   payload       jsonb (optional extra data, e.g. reaction emoji)
# ---------------------------------------------------------------------------

ENGAGEMENT_TABLE = "moltbook_engagement"

VALID_EVENT_TYPES = frozenset(
    ["view", "reaction", "comment", "share", "bookmark", "upvote", "downvote"]
)


def record_engagement(
    entry_id: str,
    agent_id: str,
    event_type: str,
    payload: dict[str, Any] | None = None,
    *,
    supabase=None,
) -> dict[str, Any] | None:
    """Append one engagement event to the ledger.

    Parameters
    ----------
    entry_id:   UUID of the moltbook entry being engaged with.
    agent_id:   Identifier of the agent or user generating the event.
    event_type: One of VALID_EVENT_TYPES.
    payload:    Optional JSON-serialisable dict with extra context.
    supabase:   Optional pre-built Supabase client (injected for testing).

    Returns the inserted row dict on success, or None on failure.
    """
    if event_type not in VALID_EVENT_TYPES:
        logger.warning(
            "record_engagement: unknown event_type '%s' (valid: %s)",
            event_type,
            ", ".join(sorted(VALID_EVENT_TYPES)),
        )
        return None

    if not entry_id or not agent_id:
        logger.warning("record_engagement: entry_id and agent_id are required")
        return None

    client = supabase or get_supabase_client()
    if client is None:
        logger.warning("record_engagement: no Supabase client available")
        return None

    row: dict[str, Any] = {
        "entry_id": entry_id,
        "agent_id": agent_id,
        "event_type": event_type,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if payload:
        row["payload"] = payload

    try:
        result = client.table(ENGAGEMENT_TABLE).insert(row).execute()
        data = result.data
        if data:
            return data[0]
        logger.warning("record_engagement: insert returned no data")
        return None
    except Exception as exc:
        logger.error("record_engagement: insert failed: %s", exc)
        return None


def get_engagement_counts(
    entry_id: str,
    *,
    supabase=None,
) -> dict[str, int]:
    """Return aggregate engagement counts for a moltbook entry.

    Returns a dict mapping event_type → count, e.g.::

        {"view": 42, "reaction": 7, "comment": 3}

    Returns an empty dict on failure.
    """
    if not entry_id:
        return {}

    client = supabase or get_supabase_client()
    if client is None:
        logger.warning("get_engagement_counts: no Supabase client available")
        return {}

    try:
        result = (
            client.table(ENGAGEMENT_TABLE)
            .select("event_type")
            .eq("entry_id", entry_id)
            .execute()
        )
        rows = result.data or []
        counts: dict[str, int] = {}
        for row in rows:
            et = row.get("event_type", "")
            if et:
                counts[et] = counts.get(et, 0) + 1
        return counts
    except Exception as exc:
        logger.error("get_engagement_counts: query failed: %s", exc)
        return {}


def get_engagement_history(
    entry_id: str,
    *,
    limit: int = 100,
    event_type: str | None = None,
    supabase=None,
) -> list[dict[str, Any]]:
    """Return raw engagement event rows for a moltbook entry.

    Parameters
    ----------
    entry_id:   UUID of the moltbook entry.
    limit:      Maximum number of rows to return (default 100).
    event_type: Optional filter to a specific event type.
    supabase:   Optional pre-built Supabase client.

    Returns a list of row dicts ordered by created_at descending.
    """
    if not entry_id:
        return []

    client = supabase or get_supabase_client()
    if client is None:
        logger.warning("get_engagement_history: no Supabase client available")
        return []

    try:
        query = (
            client.table(ENGAGEMENT_TABLE)
            .select("*")
            .eq("entry_id", entry_id)
            .order("created_at", desc=True)
            .limit(limit)
        )
        if event_type:
            query = query.eq("event_type", event_type)
        result = query.execute()
        return result.data or []
    except Exception as exc:
        logger.error("get_engagement_history: query failed: %s", exc)
        return []


def get_top_entries_by_engagement(
    *,
    event_type: str | None = None,
    limit: int = 10,
    supabase=None,
) -> list[dict[str, Any]]:
    """Return entry_ids ranked by total engagement event count.

    Parameters
    ----------
    event_type: Optional filter — only count events of this type.
    limit:      Number of top entries to return.
    supabase:   Optional pre-built Supabase client.

    Returns a list of dicts: [{"entry_id": ..., "count": ...}, ...]
    sorted descending by count.
    """
    client = supabase or get_supabase_client()
    if client is None:
        logger.warning("get_top_entries_by_engagement: no Supabase client available")
        return []

    try:
        query = client.table(ENGAGEMENT_TABLE).select("entry_id, event_type")
        if event_type:
            query = query.eq("event_type", event_type)
        result = query.execute()
        rows = result.data or []

        # Aggregate in Python (avoids needing a DB-side group-by RPC)
        counts: dict[str, int] = {}
        for row in rows:
            eid = row.get("entry_id")
            if eid:
                counts[eid] = counts.get(eid, 0) + 1

        ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        return [{"entry_id": eid, "count": cnt} for eid, cnt in ranked[:limit]]
    except Exception as exc:
        logger.error("get_top_entries_by_engagement: query failed: %s", exc)
        return []


def bulk_record_engagement(
    events: list[dict[str, Any]],
    *,
    supabase=None,
) -> int:
    """Insert multiple engagement events in a single batch.

    Each item in ``events`` must have keys: entry_id, agent_id, event_type.
    Optional key: payload (dict).

    Returns the number of successfully inserted rows.
    """
    if not events:
        return 0

    client = supabase or get_supabase_client()
    if client is None:
        logger.warning("bulk_record_engagement: no Supabase client available")
        return 0

    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for ev in events:
        event_type = ev.get("event_type", "")
        entry_id = ev.get("entry_id", "")
        agent_id = ev.get("agent_id", "")

        if event_type not in VALID_EVENT_TYPES:
            logger.warning("bulk_record_engagement: skipping unknown event_type '%s'", event_type)
            continue
        if not entry_id or not agent_id:
            logger.warning("bulk_record_engagement: skipping row missing entry_id or agent_id")
            continue

        row: dict[str, Any] = {
            "entry_id": entry_id,
            "agent_id": agent_id,
            "event_type": event_type,
            "created_at": now,
        }
        if ev.get("payload"):
            row["payload"] = ev["payload"]
        rows.append(row)

    if not rows:
        return 0

    try:
        result = client.table(ENGAGEMENT_TABLE).insert(rows).execute()
        inserted = len(result.data) if result.data else 0
        return inserted
    except Exception as exc:
        logger.error("bulk_record_engagement: insert failed: %s", exc)
        return 0
