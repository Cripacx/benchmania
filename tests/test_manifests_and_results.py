"""Manifests of all domains, result bundles in the repository, bundle verification and publishing."""

import copy
import json
import shutil

import pytest

from benchcore import bundle, manifest, project, publish

from conftest import ROOT


@pytest.fixture(scope="module")
def proj():
    return project.load(ROOT)


@pytest.fixture(scope="module")
def domains(proj):
    return manifest.load_all(proj.root)


def test_all_domains_load_and_validate(domains):
    assert "backend" in domains and "example" in domains
    for d in domains.values():
        harness_cls = manifest.load_harness(d)
        h = harness_cls.__new__(harness_cls)
        problems = [p for s in d.scenarios for p in h.validate_scenario(s)]
        problems += [p for i in d.implementations for p in harness_cls.validate_implementation(h, i)]
        assert problems == [], problems


def test_backend_shape(domains):
    b = domains["backend"]
    assert len(b.implementations) >= 15
    assert {"startup", "cold", "json", "db", "queries", "updates", "list", "orders", "rate"} <= {s.id for s in b.scenarios}
    for h in b.headline:
        assert h["metric"] in b.metrics
    for impl in b.implementations:
        assert impl.data.get("versions"), f"{impl.id} must declare versions"


def test_invalid_manifest_is_reported(tmp_path):
    d = tmp_path / "domains" / "broken"
    (d / "scenarios").mkdir(parents=True)
    (d / "implementations" / "x").mkdir(parents=True)
    (d / "domain.toml").write_text('id = "broken"\ntitle = "Broken"\nharness = "h:H"\n'
                                   '[[headline]]\nmetric = "nope"\n')
    (d / "scenarios" / "a.toml").write_text('id = "b"\ntitle = "A"\nkind = "k"\n')
    (d / "implementations" / "x" / "impl.toml").write_text('id = "x"\nname = "X"\nlanguage = "L"\ncategory = "weird"\n')
    with pytest.raises(manifest.ManifestError) as e:
        manifest.load_all(tmp_path)
    text = "\n".join(e.value.problems)
    assert "must match the file name" in text
    assert "category must be one of" in text
    assert "Dockerfile not found" in text
    assert "headline metric 'nope'" in text


def test_repository_bundles_verify(proj, domains):
    found = bundle.load_all(proj.root / "results")
    assert found, "the repository should contain at least one real result bundle"
    for path, b in found:
        assert bundle.verify(b, domains[b["domain"]], path) == [], path


def synthetic(domain):
    impls = [i.id for i in domain.implementations[:2]]
    passes = []
    for p, factor in enumerate([1.0, 1.02, 0.98], 1):
        passes.append({"index": p, "order": impls, "results": {
            impls[0]: {"scenarios": {"db": {"rps": 1000 * factor, "cpu_us_per_req": 100.0}}},
            impls[1]: {"scenarios": {"db": {"rps": 2000 * factor, "cpu_us_per_req": 50.0}}}}})
    b = {"schema": "benchcore.result/v1", "id": "t", "domain": domain.id, "created": "2026-01-01T00:00:00Z",
         "machine": {"id": "m"}, "implementations": {i: {} for i in impls}, "scenarios": {"db": {}},
         "passes": passes, "summary": {}, "quality": {"flags": []}, "options": {}}
    return bundle.finish(b)


def test_verify_detects_tampering(domains):
    d = domains["backend"]
    b = synthetic(d)
    assert bundle.verify(b, d) == []
    bad = copy.deepcopy(b)
    first = next(iter(bad["summary"]))
    bad["summary"][first]["db"]["rps"]["median"] *= 1.5
    assert any("does not match" in p for p in bundle.verify(bad, d))
    for stat, fake in (("ci95", [1000.0, 1000.0]), ("cv", 0.0), ("min", 999.0), ("outliers", [0])):
        bad = copy.deepcopy(b)  # a narrowed interval or a hidden spread is tampering too
        bad["summary"][first]["db"]["rps"][stat] = fake
        assert any("does not match" in p for p in bundle.verify(bad, d)), stat
    bad = copy.deepcopy(b)
    bad["passes"][0]["results"][first]["scenarios"]["db"]["made_up_metric"] = 1
    bad = bundle.finish(bad)
    assert any("unknown metric" in p for p in bundle.verify(bad, d))
    bad = copy.deepcopy(b)
    bad["passes"][0]["results"]["ghost"] = {"scenarios": {"nope": {"rps": 1.0}}}
    problems = bundle.verify(bundle.finish(bad), d)
    assert any("'ghost'" in p for p in problems) and any("'nope'" in p for p in problems)


def test_verify_checks_the_file_location(domains, tmp_path):
    d = domains["backend"]
    b = synthetic(d)
    good = tmp_path / "results" / d.id / "m" / "t.json"
    assert bundle.verify(b, d, good) == []
    for wrong in (tmp_path / "results" / d.id / "other-machine" / "t.json", tmp_path / "results" / d.id / "m" / "x.json"):
        assert any("file location" in p for p in bundle.verify(b, d, wrong))


def test_checkpoints_verify_and_failed_passes_are_flagged(domains):
    d = domains["backend"]
    b = synthetic(d)
    first = next(iter(b["implementations"]))
    b["passes"].append({"index": 4, "order": [first], "results": {
        first: {"error": "RuntimeError: service did not answer", "scenarios": {}}}})
    checkpoint = bundle.finish(copy.deepcopy(b), "running")
    assert checkpoint["finished"] is None and bundle.verify(checkpoint, d) == []
    flags = [f for f in bundle.finish(b)["quality"]["flags"] if f["level"] == "error"]
    assert flags and flags[0]["scope"] == first and flags[0]["pass"] == 4


def test_derived_metrics(domains):
    d = domains["backend"]
    summary = {"a": {s: {"rps": {"median": 100.0}, "cpu_us_per_req": {"median": 10.0}, "mem_pss_peak_mib": {"median": 50.0}}
                     for s in ("json", "db", "queries", "updates", "list", "orders")},
               "b": {s: {"rps": {"median": 50.0}, "cpu_us_per_req": {"median": 40.0}, "mem_pss_peak_mib": {"median": 80.0}}
                     for s in ("json", "db", "queries", "updates", "list", "orders")}}
    out = publish.derive(d, summary)
    assert out["a"]["throughput_index"] == 100
    assert out["b"]["throughput_index"] == 50
    assert out["b"]["efficiency_index"] == 25
    assert out["b"]["peak_memory_mib"] == 80


SCENARIOS = ("json", "db", "queries", "updates", "list", "orders")


def test_index_is_withheld_rather_than_flattered(domains):
    d = domains["backend"]

    def impl(rps, **override):
        s = {sid: {"rps": {"median": rps}, "cpu_us_per_req": {"median": 10.0}, "error_rate": {"median": 0.0}}
             for sid in SCENARIOS}
        for sid, metrics in override.items():
            s[sid] = {**s[sid], **metrics}
        return s

    summary = {
        "best": impl(100.0),
        "half": impl(50.0),
        "dead-in-one": impl(100.0, db={"rps": {"median": 0.0}}),            # did nothing in one workload
        "failing-fast": impl(900.0, db={"error_rate": {"median": 0.9}}),    # answers 5xx quickly
        "incomplete": {k: v for k, v in impl(100.0).items() if k != "orders"},
    }
    withheld = {}
    out = publish.derive(d, summary, withheld)
    assert out["best"]["throughput_index"] == 100
    assert out["half"]["throughput_index"] == 50
    for iid in ("dead-in-one", "failing-fast", "incomplete"):
        assert "throughput_index" not in out.get(iid, {}), iid
    assert withheld["dead-in-one"]["throughput_index"] == "Throughput of zero in: db"
    assert withheld["failing-fast"]["throughput_index"] == "Error rate above 0.01 in: db"
    assert withheld["incomplete"]["throughput_index"] == "Throughput not measured in: orders"
    assert "best" not in withheld and "half" not in withheld
    # the failing implementation must not become the reference everybody else is compared with
    assert out["half"]["throughput_index"] == 50


def test_scenario_without_information_is_left_out_for_everybody(domains):
    d = domains["backend"]
    summary = {i: {sid: {"rps": {"median": v}, "error_rate": {"median": 0.0}} for sid in SCENARIOS}
               for i, v in (("a", 100.0), ("b", 25.0))}
    for i in summary:
        summary[i]["list"]["rps"]["median"] = 0.0
    out = publish.derive(d, summary)
    assert out["a"]["throughput_index"] == 100 and out["b"]["throughput_index"] == 25


def test_publish_builds_dataset(proj, tmp_path):
    files = publish.build(proj, tmp_path)
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["project"]["name"] == proj.name
    ids = [d["id"] for d in index["domains"]]
    assert "backend" in ids and "example" not in ids
    data = json.loads((tmp_path / "backend.json").read_text())
    assert data["runs"] and data["default_run"]
    assert set(data["metrics"]) >= {"rps", "throughput_index"}
    assert len(files) == len(ids) + 1


def write_bundle(root, b):
    path = root / "results" / b["domain"] / b["machine"]["id"] / f"{b['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(b), encoding="utf-8")


def test_publish_provenance_default_run_and_exclusions(proj, domains, tmp_path):
    """Reference status is per approved run id, subset runs never become the default view, and quick runs
    and checkpoints of interrupted runs stay out of the dataset."""
    root = tmp_path / "repo"
    shutil.copytree(ROOT / "domains", root / "domains", ignore=shutil.ignore_patterns("node_modules", "target"))
    shutil.copy(ROOT / "machbench.toml", root / "machbench.toml")
    d = domains["backend"]

    def run(rid, created, **options):
        b = synthetic(d)
        b.update(id=rid, created=created, status=options.pop("status", "complete"), methodology="1")
        b["options"] = {"implementations": "all", "scenarios": "all", "quick": False, **options}
        return b

    write_bundle(root, run("full-community", "2026-01-01T00:00:00Z"))
    write_bundle(root, run("full-reference", "2026-01-02T00:00:00Z"))
    write_bundle(root, run("subset-reference", "2026-01-05T00:00:00Z", implementations=["x"]))
    write_bundle(root, run("forged", "2026-01-06T00:00:00Z"))   # same machine id, not approved
    write_bundle(root, run("quick", "2026-01-07T00:00:00Z", quick=True))
    write_bundle(root, bundle.finish(run("checkpoint", "2026-01-08T00:00:00Z"), "running"))
    (root / "results" / "reference-runs.toml").write_text(
        '[machines.m]\nlabel = "Lab machine"\nruns = ["full-reference", "subset-reference"]\n', encoding="utf-8")
    publish.build(project.load(root), tmp_path / "out")
    data = json.loads((tmp_path / "out" / "backend.json").read_text())
    runs = {r["id"]: r for r in data["runs"]}
    assert set(runs) == {"full-community", "full-reference", "subset-reference", "forged"}
    assert runs["full-reference"]["provenance"] == "reference"
    assert runs["forged"]["provenance"] == "community"
    assert data["default_run"] == "full-reference"
    assert data["machines"]["m"]["reference"] == {"label": "Lab machine"}
    value = runs["full-reference"]["results"][next(iter(runs["full-reference"]["results"]))]["db"]["rps"]
    assert value["n"] == 3 and value["lo"] <= value["m"] <= value["hi"]


def test_publish_ignores_a_stored_summary(proj, domains, tmp_path):
    """Published numbers are recomputed from the passes; verification refuses an edited summary anyway."""
    d = domains["backend"]
    b = synthetic(d)
    entry = publish._run_entry(d, {**b, "summary": {}}, set())
    first = next(iter(entry["results"]))
    assert entry["results"][first]["db"]["rps"]["m"] == b["summary"][first]["db"]["rps"]["median"]


def test_schema_file_matches_what_the_engine_writes(proj, domains):
    """The JSON schema is documentation for other tools; this keeps it from drifting away from the code."""
    from benchcore import stats
    schema = json.loads((ROOT / "core" / "benchcore" / "schemas" / "result-v1.schema.json").read_text())
    fresh = bundle.new(proj, domains["backend"], {"id": "m"}, {}, {})
    assert set(fresh) == set(schema["properties"])
    assert set(schema["required"]) <= set(fresh)
    assert schema["properties"]["schema"]["const"] == fresh["schema"]
    assert {"running", "complete", "partial"} == set(schema["properties"]["status"]["enum"])
    stat_keys = schema["properties"]["summary"]["additionalProperties"]["additionalProperties"][
        "additionalProperties"]["required"]
    assert set(stat_keys) == set(stats.summarize([1.0, 2.0, 3.0]))


def test_rename_tool(tmp_path):
    import subprocess
    import sys
    work = tmp_path / "repo"
    work.mkdir()
    for name in ("machbench.toml", "machbench", "README.md"):
        if (ROOT / name).exists():
            shutil.copy(ROOT / name, work / name)
    (work / "tools").mkdir()
    shutil.copy(ROOT / "tools" / "rename_project.py", work / "tools" / "rename_project.py")
    (work / "core" / "benchcore").mkdir(parents=True)
    shutil.copy(ROOT / "core" / "benchcore" / "project.py", work / "core" / "benchcore" / "project.py")
    r = subprocess.run([sys.executable, str(work / "tools" / "rename_project.py"), "Speedtrap"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (work / "speedtrap.toml").exists() and (work / "speedtrap").exists()
    cfg = (work / "speedtrap.toml").read_text()
    assert 'name = "Speedtrap"' in cfg and 'slug = "speedtrap"' in cfg
    assert 'CONFIG_FILE = "speedtrap.toml"' in (work / "core" / "benchcore" / "project.py").read_text()
