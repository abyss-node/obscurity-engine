"""Multi-anchor paired-bootstrap comparison of two harness JSON runs.

Extends `lb_paired_bootstrap.py` (which keys on `per_user`, only populated in
single-anchor mode) to key on `samples` -- {user, anchor, metrics} triples --
so multi-anchor runs (`--anchors a,b,c`) can be paired correctly: each
(user, anchor) pair is one sample, not each user once. Falls back to
`per_user` if a file has no `samples` key (older single-anchor artifacts).

Used for the blend n=348 re-validation: eval/vs_mult2.json (lastfm baseline,
348 samples) vs eval/blend_n348.json (blend arm, merged from 3 anchor runs).

Usage: python lb_paired_bootstrap_ma.py baseline.json variant.json "label"
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


def load_samples(path):
    d = json.loads(open(path, encoding="utf-8").read())
    out = {}
    if d.get("samples"):
        for s in d["samples"]:
            out[(s["user"], s["anchor"])] = s["metrics"]
    else:
        # single-anchor legacy artifact: per_user + anchors[0] (or "anchor":1)
        anchor = (d.get("anchors") or ["single"])[0]
        for row in d.get("per_user", []):
            if row.get("metrics"):
                out[(row["user"], anchor)] = row["metrics"]
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
    base = load_samples(base_path)
    var = load_samples(var_path)
    common = sorted(set(base) & set(var))
    print(f"\n=== {label} vs baseline === paired n={len(common)} "
          f"(baseline n={len(base)}, variant n={len(var)})")
    if set(base) != set(var):
        only_base = set(base) - set(var)
        only_var = set(var) - set(base)
        if only_base:
            print(f"  (user,anchor) only in baseline: {sorted(only_base)}")
        if only_var:
            print(f"  (user,anchor) only in variant:  {sorted(only_var)}")
    results = {}
    for key, name in METRICS:
        n, point, lo, hi, excl = paired_bootstrap(base, var, key)
        base_mean = sum(base[u][key] for u in common) / n
        var_mean = sum(var[u][key] for u in common) / n
        flag = "  <-- CI excludes 0" if excl else ""
        print(f"  {name:<18} base={base_mean:8.4f}  variant={var_mean:8.4f}  "
              f"diff={point:+8.4f}  95%CI=[{lo:+.4f}, {hi:+.4f}]{flag}")
        results[key] = {
            "base_mean": base_mean, "variant_mean": var_mean,
            "diff": point, "ci_lo": lo, "ci_hi": hi, "excludes_zero": excl,
        }
    return results


if __name__ == "__main__":
    main()
