"""Aggregate orders.csv by region: count and sum of amount_cents."""
import csv
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
regions = {}
with open(src, newline="") as f:
    for row in csv.DictReader(f):
        r = regions.setdefault(row["region"], {"count": 0, "sum_cents": 0})
        r["count"] += 1
        r["sum_cents"] += int(row["amount_cents"])
out = {
    "regions": dict(sorted(regions.items())),
    "total": {
        "count": sum(r["count"] for r in regions.values()),
        "sum_cents": sum(r["sum_cents"] for r in regions.values()),
    },
}
with open(dst, "w") as f:
    json.dump(out, f, indent=2)
print(json.dumps(out["total"]))
