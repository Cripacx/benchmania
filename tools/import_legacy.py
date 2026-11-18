#!/usr/bin/env python3
"""Import results of the pre-release shell suite (methodology 0) into a result bundle.

The pre-release suite ran the same 15 implementations and scenarios on bare metal before the engine existed.
It recorded throughput, p50/p99 latency, errors, start-up and memory, but not CPU per request, database work or
image digests, and it built from floating image tags. Bundles created here carry methodology "0" so the website
can label them.

    python3 tools/import_legacy.py <machine.json> <suite_pass1.json> [suite_pass2.json ...]
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "core"))

from benchcore import RESULT_SCHEMA, __version__, bundle, manifest, project as project_mod  # noqa: E402
from benchcore.machine import machine_id, short_label  # noqa: E402

IDS = {"go": "go-nethttp", "rust": "rust-axum", "dotnet-jit": "dotnet11-jit", "dotnet-aot": "dotnet11-aot",
       "dotnet10-jit": "dotnet10-jit", "dotnet10-aot": "dotnet10-aot", "java-jvm": "java-spring-jvm",
       "java-aotcache": "java-spring-aotcache", "java-native": "java-spring-native", "node-fastify": "node-fastify",
       "node-express": "node-express", "bun": "bun-serve", "python": "python-fastapi", "php": "php-frankenphp",
       "elixir": "elixir-bandit"}
SCENARIOS = {"cold": "cold", "json": "json", "db": "db", "queries": "queries", "updates": "updates", "list": "list",
             "orders": "orders", "db_c16": "db-c16", "db_c512": "db-c512"}


def convert(old):
    sc = {"startup": {"startup_ms": old["startup_ms"], "startup_min_ms": min(old["startup_all"]),
                      "startup_max_ms": max(old["startup_all"]), "idle_pss_mib": old["idle_pss_mib"],
                      "idle_anon_mib": old["idle_anon_mib"], "image_mb": old["image_mb"]}}
    for o, n in SCENARIOS.items():
        r = old[o]
        sc[n] = {"rps": r["rps"], "latency_p50_ms": r["p50_ms"], "latency_p99_ms": r["p99_ms"], "errors": r["errors"]}
    # The pre-release suite sampled peak memory once across all load scenarios; it is recorded on "db".
    sc["db"]["mem_pss_peak_mib"] = old["peak_pss_mib"]
    sc["db"]["mem_anon_peak_mib"] = old["peak_anon_mib"]
    sc["cold"]["warm_ratio"] = old["cold"]["rps"] / old["db"]["rps"]
    r = old["rate"]
    sc["rate"] = {"rps": r["rps"], "latency_p50_ms": r["p50_ms"], "latency_p99_ms": r["p99_ms"],
                  "latency_p99_9_ms": r["p999_ms"], "errors": r["non200"]}
    return sc


def main(machine_file, pass_files):
    project = project_mod.load(ROOT)
    domain = manifest.load_all(ROOT)["backend"]
    m = json.loads(Path(machine_file).read_text())
    m["id"] = machine_id(m["cpu"]["model"], m["cpu"]["logical"], m["cpu"]["physical_cores"], m["memory_gib"],
                         m["virtualization"], m.pop("board_vendor", None), m.pop("board_name", None))
    m.setdefault("label", short_label(m["cpu"]["model"], m["cpu"]["logical"]))
    passes = [json.loads(Path(f).read_text()) for f in pass_files]
    started, finished = m.pop("run_started"), m.pop("run_finished", None)
    b = {
        "schema": RESULT_SCHEMA, "id": f"{started.replace('-', '').replace(':', '')[:13]}Z-{m['id'][:6]}-legacy",
        "domain": "backend", "created": started, "finished": finished, "status": "complete",
        "tool": {"name": project.slug, "engine_version": f"import_legacy ({__version__})", "git": None},
        "methodology": "0",
        "options": {"passes": len(passes), "quick": False, "implementations": "all", "scenarios": "all",
                    "note": "Pre-release shell suite: wrk 3 threads, 128 connections, 3 s warm-up + 12 s measured "
                            "per scenario, 5,000 req/s fixed-rate run with oha, floating image tags."},
        "machine": m,
        "layout": {"service": [0, 1], "environment": [2, 3, 8, 9], "loadgen": [4, 5, 10, 11], "idle": [6, 7],
                   "smt": True, "warnings": []},
        "implementations": {}, "scenarios": {}, "passes": [], "summary": {}, "quality": {"flags": []},
    }
    used = {s for s in SCENARIOS.values()} | {"startup", "rate"}
    b["scenarios"] = {s.id: s.to_public() for s in domain.scenarios if s.id in used}
    for i, data in enumerate(passes, 1):
        rec = {"index": i, "order": [IDS[k] for k in data], "started": None, "results": {}}
        for old_id, r in data.items():
            if "error" in r:
                continue
            rec["results"][IDS[old_id]] = {"scenarios": convert(r), "quality": {}, "notes": []}
        b["passes"].append(rec)
    for old_id, new_id in IDS.items():
        impl = domain.implementation(new_id)
        public = impl.to_public()
        public["versions_note"] = "Built from floating tags at run time; versions match the pinned ones closely but not exactly."
        sizes = [p[old_id]["image_mb"] for p in passes if old_id in p and "image_mb" in p[old_id]]
        checks = sorted({p[old_id].get("validate", "missing") for p in passes if old_id in p})
        b["implementations"][new_id] = {"manifest": public, "image": {"size_bytes": int(sizes[0] * 1e6) if sizes else None},
                                        "check": "ok" if checks == ["OK"] else checks}
    bundle.finish(b, "complete")
    b["finished"] = finished  # when the suite ended, not when it was imported
    path = bundle.write(b, ROOT / "results")
    problems = bundle.verify(b, domain, path)
    print(f"wrote {path.relative_to(ROOT)} ({len(passes)} passes); verify: {problems or 'ok'}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
