"""Turn result bundles into the website dataset.

Output (default `site/src/data/`):
    index.json            project identity, domain list
    <domain>.json         metrics, scenarios, implementations, machines, runs with summaries and derived metrics

The dataset contains every summarized metric, not only the ones the website shows today, so the
visualization can change without touching collection. Example domains are excluded unless asked for.
"""

import datetime as dt
import json
import tomllib
from pathlib import Path

from . import DATASET_SCHEMA, bundle, manifest, stats


def _compact(s):
    lo, hi = s["ci95"] or (None, None)  # no interval below three passes
    return {"m": s["median"], "lo": lo, "hi": hi, "min": s["min"], "max": s["max"],
            "n": s["n"], "cv": round(s["cv"], 4)}


def derive(domain, summary, withheld=None):
    """Domain-declared derived metrics, computed from summary medians of one run.

    `geomean_relative` is an index: the geometric mean over the listed scenarios of each implementation's
    value relative to the best one (100 = best everywhere). An implementation gets an index only when it has
    a usable result in every scenario: a missing scenario, a throughput of zero or a failed `valid_when`
    condition (e.g. more than 1 % errors) withholds the index instead of flattering it. The reason is
    written to `withheld[implementation][derived id]` so that the website can say why a value is missing.
    """
    out = {}
    withheld = {} if withheld is None else withheld
    impls = list(summary)
    for d in domain.data.get("derived", []):
        did, kind, metric = d["id"], d["kind"], d["metric"]
        scen = d.get("scenarios", "*")

        def values(iid):
            res = {}
            for sid, metrics in summary[iid].items():
                if (scen == "*" or sid in scen) and metric in metrics:
                    res[sid] = metrics[metric]["median"]
            return res

        def valid(iid, sids):
            cond = d.get("valid_when")
            if not cond:
                return True
            observed = [summary[iid].get(s, {}).get(cond["metric"]) for s in sids]
            return all(o is None or o["median"] <= cond["max"] for o in observed)

        if kind == "max":
            for iid in impls:
                v = values(iid)
                if v:
                    out.setdefault(iid, {})[did] = max(v.values())
        elif kind == "geomean_relative":
            pick = max if domain.metrics[metric].better == "higher" else min
            have = {iid: values(iid) for iid in impls}
            sids = sorted({s for v in have.values() for s in v})
            complete = [i for i in impls if sids and set(have[i]) == set(sids) and valid(i, sids)]
            # A scenario whose best value is 0 carries no information (nobody did any work, or the metric
            # has a floor of zero): it is left out for everybody rather than skipped per implementation.
            usable = [s for s in sids if complete and pick(have[i][s] for i in complete) > 0]
            # Only implementations that get an index are compared with each other.
            eligible = [i for i in complete if all(have[i][s] > 0 for s in usable)]
            best = {s: pick(have[i][s] for i in eligible) for s in usable} if eligible else {}
            for iid in eligible:
                ratios = [have[iid][s] / best[s] if pick is max else best[s] / have[iid][s] for s in best]
                if ratios:
                    out.setdefault(iid, {})[did] = round(100 * stats.geomean(ratios), 2)
            label = domain.metrics[metric].label
            cond = d.get("valid_when")
            for iid in impls if sids else []:
                if iid in eligible:
                    continue
                missing = [s for s in sids if s not in have[iid]]
                failing = [s for s in sids if not valid(iid, [s])]
                zero = [s for s in usable if s in have[iid] and have[iid][s] <= 0]
                if missing:
                    reason = f"{label} not measured in: {', '.join(missing)}"
                elif failing:
                    reason = f"{domain.metrics[cond['metric']].label} above {cond['max']:g} in: {', '.join(failing)}"
                elif zero:
                    reason = f"{label} of zero in: {', '.join(zero)}"
                else:
                    continue
                withheld.setdefault(iid, {})[did] = reason
        else:
            raise ValueError(f"unknown derived kind '{kind}' in {domain.id}/domain.toml")
    return out


REFERENCE_FILE = "reference-runs.toml"


def reference_runs(results_dir):
    """({machine id: public info}, {run ids}) of runs that maintainers measured themselves.

    Approval is per run id, not per machine: the machine id is a hash of hardware facts that every machine
    of the same model shares, so it cannot prove who measured. The file is protected by CODEOWNERS.
    """
    path = Path(results_dir) / REFERENCE_FILE
    if not path.is_file():
        return {}, set()
    with open(path, "rb") as f:
        machines = tomllib.load(f).get("machines", {})
    info = {mid: {k: v for k, v in m.items() if k != "runs"} for mid, m in machines.items()}
    return info, {(mid, rid) for mid, m in machines.items() for rid in m.get("runs", [])}


def _run_entry(domain, b, approved):
    summary = bundle.summarize(b["passes"])  # recomputed: the stored summary is never trusted
    results = {iid: {sid: {mid: _compact(s) for mid, s in metrics.items()} for sid, metrics in scen.items()}
               for iid, scen in summary.items()}
    withheld = {}
    derived = derive(domain, summary, withheld)
    return {
        "id": b["id"], "created": b["created"], "finished": b.get("finished"), "status": b.get("status"),
        "methodology": b.get("methodology"), "machine": b["machine"]["id"],
        "provenance": "reference" if (b["machine"]["id"], b["id"]) in approved else "community",
        "options": b.get("options", {}), "layout": b.get("layout", {}),
        "tool": b.get("tool", {}), "passes": len(b["passes"]),
        "implementations": {iid: {"image": e.get("image", {}), "check": e.get("check"),
                                  "manifest": e.get("manifest", {})}
                            for iid, e in b["implementations"].items()},
        "results": results,
        "derived": derived,
        "withheld": withheld,  # implementation -> derived metric -> why it has no value
        # recomputed like the summary, so every published run follows the current rules for flags
        "flags": bundle.quality_flags({**b, "summary": summary}),
    }


def build(project, out_dir, include_examples=False):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    domains = manifest.load_all(project.root)
    results_dir = project.root / project.run.get("results_dir", "results")
    index = {"schema": DATASET_SCHEMA,
             "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
             "project": project.to_public(), "domains": []}
    written = []
    reference, approved = reference_runs(results_dir)
    for did, domain in domains.items():
        if domain.status == "example" and not include_examples:
            continue
        runs, machines = [], {}
        for path, b in bundle.load_all(results_dir, did):
            problems = bundle.verify(b, domain, path)
            if problems:
                raise ValueError(f"{path}: {problems[0]} (+{len(problems) - 1} more)")
            if not b["passes"] or b.get("options", {}).get("quick") or b.get("status") == "running":
                continue  # smoke tests and checkpoints of interrupted runs are never published
            runs.append(_run_entry(domain, b, approved))
            machines[b["machine"]["id"]] = {**b["machine"], "reference": reference.get(b["machine"]["id"])}
        runs.sort(key=lambda r: r["created"], reverse=True)
        featured = domain.data.get("featured_run")

        def rank(r):  # default view: full coverage first, then reference, newest methodology, complete, passes, newest
            o = r["options"]
            full = o.get("implementations") == "all" and o.get("scenarios") == "all"
            return (full, r["provenance"] == "reference", int(r.get("methodology") or 0), r["status"] == "complete",
                    r["passes"], r["created"])

        default = featured if any(r["id"] == featured for r in runs) else \
            (max(runs, key=rank)["id"] if runs else None)
        data = {
            "schema": DATASET_SCHEMA,
            "domain": domain.to_public(),
            "metrics": {k: m.to_public() for k, m in domain.metrics.items()},
            "derived": domain.data.get("derived", []),
            "scenarios": [s.to_public() for s in domain.scenarios],
            "implementations": [i.to_public() for i in domain.implementations],
            "machines": machines,
            "runs": runs,
            "default_run": default,
        }
        f = out_dir / f"{did}.json"
        f.write_text(json.dumps(data, indent=None, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
        written.append(f)
        index["domains"].append({**domain.to_public(), "runs": len(runs), "implementations": len(domain.implementations),
                                 "scenarios": len(domain.scenarios), "machines": len(machines), "default_run": default})
    (out_dir / "index.json").write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8", newline="\n")
    return [out_dir / "index.json", *written]
