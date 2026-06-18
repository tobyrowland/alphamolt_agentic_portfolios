"""Parity check: run the shared fixture through screen.py and compare final_pct
/ ranks to the TS scorer's output (parity_check.mjs). Exits non-zero on any
divergence. Run from web/:  node parity_check.mjs > /tmp/ts.json && python compare_parity.py /tmp/ts.json"""
import json
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import screen  # noqa: E402

fx = json.load(open(os.path.join(os.path.dirname(__file__), "parity_fixture.json")))
ts = json.load(open(sys.argv[1]))

ranked = screen.score_screen(fx["rows"], fx["config"], fx["stats"])
py = {
    r["ticker"]: {
        "final_pct": r["final_pct"],
        "base_pct": r["base_pct"],
        "rank": r["rank"],
        "adj_z": round(r["adj_z"], 6),
        "base_z": round(r["base_z"], 6),
    }
    for r in ranked
}

ok = True
for row in ts:
    t = row["ticker"]
    p = py.get(t)
    if p is None:
        print(f"MISSING in python: {t}")
        ok = False
        continue
    for k in ("final_pct", "base_pct", "rank"):
        if row[k] != p[k]:
            print(f"DIVERGE {t}.{k}: ts={row[k]} py={p[k]}")
            ok = False
    for k in ("adj_z", "base_z"):
        if abs(row[k] - p[k]) > 1e-6:
            print(f"DIVERGE {t}.{k}: ts={row[k]} py={p[k]}")
            ok = False

print("PARITY OK" if ok else "PARITY FAILED")
sys.exit(0 if ok else 1)
