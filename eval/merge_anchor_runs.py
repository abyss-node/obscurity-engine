"""Merge N single-anchor harness JSON runs (same cohort/config, different
--anchor) into one multi-anchor artifact, matching the exact shape harness.py
itself writes for `--anchors a,b,c` (per_anchor, samples, aggregate, ci).

Used for the blend n=348 re-validation: the blend arm is run as 3 separate
--anchor invocations (to respect the ListenBrainz rate limit and checkpoint
per-anchor), then merged here so the downstream paired-bootstrap script sees
one 348-sample artifact just like the lastfm-arm baseline (eval/vs_mult2.json).

Usage: python merge_anchor_runs.py out.json run1.json run2.json run3.json
"""
from __future__ import annotations
import json
import sys

from metrics import aggregate, confidence_intervals


def main() -> None:
    out_path, *in_paths = sys.argv[1:]
    if not in_paths:
        raise SystemExit("usage: merge_anchor_runs.py out.json run1.json [run2.json ...]")

    runs = [json.loads(open(p, encoding="utf-8").read()) for p in in_paths]

    # sanity: same config (ignore nothing — candidate_source etc. must match)
    base_cfg = runs[0]["config"]
    for p, r in zip(in_paths, runs):
        if r["config"] != base_cfg:
            diffs = {k: (base_cfg.get(k), r["config"].get(k))
                     for k in set(base_cfg) | set(r["config"])
                     if base_cfg.get(k) != r["config"].get(k)}
            raise SystemExit(f"config mismatch in {p}: {diffs}")

    anchors = []
    per_anchor = {}
    samples = []
    listenbrainz_resolution = None
    for p, r in zip(in_paths, runs):
        if len(r["anchors"]) != 1:
            raise SystemExit(f"{p} is not a single-anchor run (anchors={r['anchors']})")
        a = r["anchors"][0]
        if a in per_anchor:
            raise SystemExit(f"duplicate anchor {a} across inputs")
        anchors.append(a)
        per_anchor[a] = r["per_anchor"][a]
        samples.extend(r["samples"])
        lb = r.get("listenbrainz_resolution")
        if lb:
            if listenbrainz_resolution is None:
                listenbrainz_resolution = {k: 0 for k in lb if isinstance(lb[k], (int, float))}
            for k, v in lb.items():
                if isinstance(v, (int, float)) and k != "miss_rate":
                    listenbrainz_resolution[k] = listenbrainz_resolution.get(k, 0) + v

    if listenbrainz_resolution is not None:
        total = listenbrainz_resolution.get("total_resolution_attempts", 0)
        unresolved = listenbrainz_resolution.get("unresolved", 0)
        listenbrainz_resolution["miss_rate"] = (unresolved / total) if total else 0.0

    per_user_metrics = [s["metrics"] for s in samples]
    agg = aggregate(per_user_metrics)
    ci_keys = ["obscurity_weighted@k", "mrr", "recall@k", "precision@k", "reach"]
    cis = confidence_intervals(per_user_metrics, ci_keys) if agg else {}

    out = {
        "config": base_cfg,
        "anchors": anchors,
        "per_user": [],  # multi-anchor mode never populates this (matches harness.py)
        "per_anchor": per_anchor,
        "samples": samples,
        "aggregate": agg,
        "ci": {k: list(v) for k, v in cis.items()},
        "listenbrainz_resolution": listenbrainz_resolution,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"merged {len(in_paths)} anchor runs -> {len(samples)} samples -> {out_path}")
    if listenbrainz_resolution:
        print(f"  pooled ListenBrainz resolution: {listenbrainz_resolution}")


if __name__ == "__main__":
    main()
