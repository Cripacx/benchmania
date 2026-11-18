"""Result bundles: one JSON file per run, self-describing and verifiable.

    results/<domain>/<machine-id>/<run-id>.json

A bundle holds every per-pass measurement plus a summary derived from them. `verify` recomputes the
summary from the passes, so a hand-edited summary is detected in CI.
"""

import datetime as dt
import json
import math
import os
import secrets
import subprocess
from pathlib import Path

from . import RESULT_SCHEMA, __version__, stats

REQUIRED = ("schema", "id", "domain", "created", "machine", "implementations", "scenarios", "passes", "summary")


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_id(machine_id):
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%MZ")
    return f"{stamp}-{machine_id[:6]}-{secrets.token_hex(2)}"


def git_state(root):
    """Commit of the measured code; None when git or the repository metadata is unavailable."""
    def g(*args):
        try:
            # safe.directory: inside the runner the repository is owned by another user.
            # --no-optional-locks: `git status` must not rewrite .git/index as root.
            p = subprocess.run(["git", "--no-optional-locks", "-c", "safe.directory=*", "-C", str(root), *args],
                               capture_output=True, text=True, timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        return p.stdout.strip() if p.returncode == 0 else None
    commit = g("rev-parse", "HEAD")
    if commit is None:
        return None
    return {"commit": commit, "branch": g("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(g("status", "--porcelain", "--untracked-files=no"))}


def summarize(passes):
    """{impl: {scenario: {metric: stats}}} over all passes; metrics missing in a pass are skipped."""
    values = {}
    for p in passes:
        for iid, r in p.get("results", {}).items():
            for sid, metrics in r.get("scenarios", {}).items():
                for mid, v in metrics.items():
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        values.setdefault(iid, {}).setdefault(sid, {}).setdefault(mid, []).append(v)
    out = {}
    for iid, scen in values.items():
        for sid, metrics in scen.items():
            for mid, vals in metrics.items():
                s = stats.summarize(vals)
                if s:
                    out.setdefault(iid, {}).setdefault(sid, {})[mid] = s
    return out


def quality_flags(bundle):
    """Human-readable warnings derived from the passes (shown next to the results)."""
    flags = []
    for w in bundle.get("layout", {}).get("warnings", []):
        flags.append({"level": "warning", "scope": "run", "message": w})
    for p in bundle["passes"]:
        for iid, r in p.get("results", {}).items():
            if r.get("error"):  # the whole measurement of this pass failed: its values are missing from n
                flags.append({"level": "error", "scope": iid, "pass": p["index"],
                              "message": f"measurement failed in pass {p['index']}: {r['error'][:300]}"})
            for sid, q in r.get("quality", {}).items():
                for msg in q.get("flags", []):
                    flags.append({"level": "warning", "scope": f"{iid}/{sid}", "pass": p["index"], "message": msg})
    for iid, scen in bundle.get("summary", {}).items():
        for sid, metrics in scen.items():
            s = metrics.get("rps")
            if s and s["n"] >= 3 and s["cv"] > 0.10:
                flags.append({"level": "info", "scope": f"{iid}/{sid}",
                              "message": f"throughput varies {s['cv'] * 100:.0f} % between passes"})
    return flags


def write(bundle, results_dir):
    path = Path(results_dir) / bundle["domain"] / bundle["machine"]["id"] / f"{bundle['id']}.json"
    existing = next(p for p in path.parents if p.exists())
    created = [p for p in path.parents if existing in p.parents]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(bundle, indent=1, sort_keys=False) + "\n", encoding="utf-8", newline="\n")
    # The runner container writes as root; hand the files to the owner of the directory they land in,
    # so that the bundle can be committed (or deleted) without sudo.
    try:
        owner = existing.stat()
        for p in (*created, tmp):
            os.chown(p, owner.st_uid, owner.st_gid)
    except (AttributeError, OSError):  # no chown on Windows; not permitted when not root
        pass
    tmp.replace(path)
    return path


def load_all(results_dir, domain=None):
    base = Path(results_dir)
    pattern = f"{domain}/*/*.json" if domain else "*/*/*.json"
    out = []
    for f in sorted(base.glob(pattern)):
        with open(f, encoding="utf-8") as fh:
            out.append((f, json.load(fh)))
    return out


def _same(a, b):
    """Equality of two summary values (numbers, None or lists of them) up to float round-off."""
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)
    return a == b


def verify(bundle, domain=None, path=None):
    """List of problems: structure, the stored summary against one recomputed from the passes (every
    statistic, not only the median), ids known to the bundle and the domain, and the file location."""
    problems = [f"missing key '{k}'" for k in REQUIRED if k not in bundle]
    if problems:
        return problems
    if bundle["schema"] != RESULT_SCHEMA:
        problems.append(f"unsupported schema {bundle['schema']!r} (expected {RESULT_SCHEMA})")
    if domain is not None and bundle["domain"] != domain.id:
        problems.append(f"bundle domain {bundle['domain']!r} does not match {domain.id!r}")
    if path is not None:
        expected = (bundle["domain"], bundle["machine"].get("id"), f"{bundle['id']}.json")
        if tuple(Path(path).parts[-3:]) != expected:
            problems.append("file location does not match the bundle: expected <results>/" + "/".join(map(str, expected)))
    for p in bundle["passes"]:
        for iid, r in p.get("results", {}).items():
            if iid not in bundle["implementations"]:
                problems.append(f"pass {p.get('index')} has results for '{iid}', which the bundle does not describe")
            for sid in r.get("scenarios", {}):
                if sid not in bundle["scenarios"]:
                    problems.append(f"pass {p.get('index')} has scenario '{sid}', which the bundle does not describe")
    fresh = summarize(bundle["passes"])
    for iid, scen in fresh.items():
        for sid, metrics in scen.items():
            for mid, s in metrics.items():
                stored = bundle["summary"].get(iid, {}).get(sid, {}).get(mid)
                if not stored or set(stored) != set(s) or not all(_same(stored[k], s[k]) for k in s):
                    problems.append(f"summary for {iid}/{sid}/{mid} does not match the per-pass data")
    for iid, scen in bundle["summary"].items():
        for sid, metrics in scen.items():
            for mid in metrics:
                if mid not in fresh.get(iid, {}).get(sid, {}):
                    problems.append(f"summary has {iid}/{sid}/{mid} without per-pass data")
                if domain is not None and mid not in domain.metrics:
                    problems.append(f"unknown metric '{mid}' in {iid}/{sid}")
    if domain is not None:
        for sid in bundle["scenarios"]:
            if sid not in {s.id for s in domain.scenarios}:
                problems.append(f"unknown scenario '{sid}'")
    return problems


def new(project, domain, machine, layout, options):
    return {
        "schema": RESULT_SCHEMA,
        "id": run_id(machine["id"]),
        "domain": domain.id,
        "created": now(),
        "finished": None,
        "status": "running",
        "tool": {"name": project.slug, "engine_version": __version__, "git": git_state(project.root)},
        "methodology": str(domain.data.get("methodology_version", "1")),
        "options": options,
        "machine": machine,
        "layout": layout,
        "implementations": {},
        "scenarios": {},
        "passes": [],
        "summary": {},
        "quality": {"flags": []},
    }


def finish(bundle, status="complete"):
    """Derive summary and flags from the passes. Also used for checkpoints (status "running"), so that a
    bundle on disk always verifies, whatever happens to the run afterwards."""
    bundle["summary"] = summarize(bundle["passes"])
    bundle["quality"]["flags"] = quality_flags(bundle)
    bundle["finished"] = None if status == "running" else now()
    bundle["status"] = status
    return bundle
