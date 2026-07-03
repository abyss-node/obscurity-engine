"""Paired-bootstrap comparison of two harness JSON runs (same users, same
anchor, same config except candidate_source). Used for the T-C
(ListenBrainz candidate-source A/B) verdict in
docs/spike-listenbrainz-2026-07-03.md.

Usage: python lb_paired_bootstrap.py baseline.json variant.json "label"
"""
import json
import random
import sys

METRICS = [
    ("reach", "reach"),
    ("discovery_hits", "pure-discovery hits"),
    ("obscurity_weighted@k", "obscW@k"),
    ("mrr", "MRR"),
    ("hits", "hits (any)"),
    ("recall@k", "recall@k"),
]


def load_metrics(path):
    d = json.loads(open(path, encoding="utf-8").read())
    out = {}
    for row in d["per_user"]:
        if row.get("metrics"):
            out[row["user"]] = row["metrics"]
    return out


def paired_bootstrap(base, var, key, n_boot=5000, seed=12345):
    common = sorted(set(base) & set(var))
    n = len(common)
    diffs = [var[u][key] - base[u][key] for u in common]
    point = sum(diffs) / n
    rng = random.Random(seed)
    boots = []
    for _ in range(n_boot):
        idx = [rng.randrange(n) for _ in range(n)]
        boots.append(sum(diffs[i] for i in idx) / n)
    boots.sort()
    lo = boots[int(0.025 * n_boot)]
    hi = boots[int(0.975 * n_boot)]
    excludes_zero = (lo > 0) or (hi < 0)
    return n, point, lo, hi, excludes_zero


def main():
    base_path, var_path, label = sys.argv[1], sys.argv[2], sys.argv[3]
    base = load_metrics(base_path)
    var = load_metrics(var_path)
    common = sorted(set(base) & set(var))
    print(f"\n=== {label} vs baseline === paired n={len(common)} "
          f"(baseline n={len(base)}, variant n={len(var)})")
    if set(base) != set(var):
        only_base = set(base) - set(var)
        only_var = set(var) - set(base)
        if only_base:
            print(f"  users only in baseline: {sorted(only_base)}")
        if only_var:
            print(f"  users only in variant:  {sorted(only_var)}")
    for key, name in METRICS:
        n, point, lo, hi, excl = paired_bootstrap(base, var, key)
        base_mean = sum(base[u][key] for u in common) / n
        var_mean = sum(var[u][key] for u in common) / n
        flag = "  <-- CI excludes 0" if excl else ""
        print(f"  {name:<18} base={base_mean:8.4f}  variant={var_mean:8.4f}  "
              f"diff={point:+8.4f}  95%CI=[{lo:+.4f}, {hi:+.4f}]{flag}")


if __name__ == "__main__":
    main()
