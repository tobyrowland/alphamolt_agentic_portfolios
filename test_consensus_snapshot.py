"""Unit tests for consensus_snapshot.aggregate().

Pins the post-migration behaviour: holdings now come from per-portfolio
`portfolio_holdings` (each portfolio is a "player"), and the public /consensus
page may only NAME public portfolios in top_holders — private ones still count
toward the aggregate totals but are omitted from the named holder list.
"""

from consensus_snapshot import aggregate


def _h(agent_id, ticker, qty, cost, *, handle="p", name="P", is_public=True,
       price=100.0):
    return {
        "agent_id": agent_id, "ticker": ticker, "quantity": qty,
        "avg_cost_usd": cost, "handle": handle, "display_name": name,
        "is_public": is_public, "current_price": price,
    }


def test_basic_aggregation_counts_and_pnl():
    rows = [
        _h("A", "NVDA", 10, 100.0, handle="a", name="Agent A", price=110.0),
        _h("B", "NVDA", 10, 120.0, handle="b", name="Agent B", price=110.0),
        _h("A", "MSFT", 5, 50.0, handle="a", name="Agent A", price=50.0),
    ]
    out, total_agents = aggregate(rows)
    assert total_agents == 2  # distinct agents holding anything
    nvda = next(r for r in out if r["ticker"] == "NVDA")
    assert nvda["num_agents"] == 2
    assert nvda["pct_agents"] == 100.0
    # swarm_avg_entry = (10*100 + 10*120) / 20 = 110; price 110 -> pnl ~0
    assert nvda["swarm_avg_entry"] == 110.0
    assert nvda["swarm_pnl_pct"] == 0.0
    # NVDA (2 holders) ranks above MSFT (1 holder)
    assert out[0]["ticker"] == "NVDA"
    assert out[0]["rank"] == 1


def test_private_holders_counted_but_not_named():
    """A private portfolio adds to num_agents / pct_agents but never appears in
    the public top_holders list."""
    rows = [
        _h("PUB", "RDDT", 10, 100.0, handle="pub", name="Public", is_public=True),
        _h("PRIV", "RDDT", 10, 100.0, handle="priv", name="Private",
           is_public=False),
    ]
    out, total_agents = aggregate(rows)
    assert total_agents == 2
    rddt = out[0]
    assert rddt["num_agents"] == 2          # both counted
    assert rddt["pct_agents"] == 100.0
    holders = rddt["top_holders"]
    assert len(holders) == 1                 # only the public one is named
    assert holders[0]["handle"] == "pub"
    assert all(h["handle"] != "priv" for h in holders)


def test_missing_is_public_fails_closed():
    """A holder row without an is_public key is treated as private (excluded
    from top_holders) — fail-closed, so a data-shape regression can't leak."""
    row = _h("X", "AAPL", 1, 10.0, handle="x", name="X")
    del row["is_public"]
    out, _ = aggregate([row])
    assert out[0]["num_agents"] == 1
    assert out[0]["top_holders"] == []


def test_all_private_yields_empty_top_holders_but_real_count():
    rows = [
        _h("P1", "ALNY", 1, 10.0, handle="p1", is_public=False),
        _h("P2", "ALNY", 1, 10.0, handle="p2", is_public=False),
    ]
    out, total_agents = aggregate(rows)
    assert total_agents == 2
    assert out[0]["num_agents"] == 2
    assert out[0]["top_holders"] == []       # nothing to name, but still ranked


def test_zero_quantity_rows_ignored():
    rows = [
        _h("A", "NVDA", 0, 100.0),           # dropped
        _h("B", "NVDA", 5, 100.0, handle="b"),
    ]
    out, total_agents = aggregate(rows)
    assert total_agents == 1
    assert out[0]["num_agents"] == 1
