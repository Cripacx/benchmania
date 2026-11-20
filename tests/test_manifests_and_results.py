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


def test_invalid_comparisons_and_methodology_are_reported(tmp_path):
    d = tmp_path / "domains" / "shown"
    (d / "scenarios").mkdir(parents=True)
    (d / "implementations" / "x").mkdir(parents=True)
    (d / "domain.toml").write_text(
        'id = "shown"\ntitle = "Shown"\nharness = "h:H"\n'
        '[[compare]]\ntitle = "Pair"\nids = ["x", "ghost"]\n'
        '[[compare]]\ntitle = "Alone"\nids = ["x"]\n'
        '[methodology]\ndocument = "../outside.md"\nroles = { database = "PostgreSQL" }\n'
        'checks = [{ check = "something" }]\nversions = { "v2" = "text" }\nsummary = "unknown key"\n')
    (d / "implementations" / "x" / "impl.toml").write_text('id = "x"\nname = "X"\nlanguage = "L"\ncategory = "tool"\n')
    (d / "implementations" / "x" / "Dockerfile").write_text("FROM scratch\n")
    with pytest.raises(manifest.ManifestError) as e:
        manifest.load_all(tmp_path)
    text = "\n".join(e.value.problems)
    assert "names 'ghost', which is not an implementation" in text
    assert "two to four different implementations" in text
    assert "document must be a path relative to the repository root" in text
    assert "unknown role 'database'" in text
    assert "needs 'check' and 'effect'" in text
    assert "key 'v2' must be a methodology version" in text
    assert "unknown key 'summary'" in text


def _presentation(tmp_path, toml):
    """Problems of a minimal domain with implementations x and y plus the given presentation tables."""
    d = tmp_path / "domains" / "shown"
    (d / "scenarios").mkdir(parents=True, exist_ok=True)
    for i in ("x", "y"):
        (d / "implementations" / i).mkdir(parents=True, exist_ok=True)
        (d / "implementations" / i / "impl.toml").write_text(f'id = "{i}"\nname = "{i}"\nlanguage = "L"\ncategory = "tool"\n')
        (d / "implementations" / i / "Dockerfile").write_text("FROM scratch\n")
    (d / "domain.toml").write_text('id = "shown"\ntitle = "Shown"\nharness = "h:H"\n' + toml)
    try:
        manifest.load_domain(d)
    except manifest.ManifestError as e:
        return "\n".join(e.problems)
    return ""


@pytest.mark.parametrize("toml, expected", [
    ('[[compare]]\ntitle = "Nested"\nids = [["x"], ["y"]]\n', "two to four different implementations"),
    ('[[compare]]\ntitle = "Numbers"\nids = [1, 2]\n', "two to four different implementations"),
    ('[[compare]]\ntitle = 3\nids = ["x", "y"]\n', "needs a 'title'"),
    ('[[compare]]\ntitle = "Pair"\nids = ["x", "y"]\nnote = 4\n', "'note' must be a non-empty string"),
    ('compare = "x,y"\n', "[[compare]] must be a list"),
    ('compare = ["x"]\n', "[[compare]] 1 must be a table"),
    ('ranking_note = 7\n', "ranking_note must be"),
    ('ranking_note = ""\n', "ranking_note must be"),
    ('methodology = "text"\n', "[methodology] must be a table"),
    ('[methodology]\nlimitations = "One sentence."\n', "limitations must be a list of sentences"),
    ('[methodology]\nlimitations = ["ok", 2]\n', "limitations must be a list of sentences"),
    ('[methodology]\nroles = { service = 1 }\n', "name of 'service' must be a string"),
    ('[methodology]\nroles = ["service"]\n', "[methodology.roles] must be a table"),
    ('[methodology]\nchecks = "check"\n', "checks must be a list"),
    ('[methodology]\nchecks = ["check"]\n', "needs 'check' and 'effect'"),
    ('[methodology]\nchecks = [{ check = 1, effect = "x" }]\n', "needs 'check' and 'effect'"),
    ('[methodology]\nversions = { "1" = 2 }\n', "description of '1' must be a non-empty string"),
    ('[methodology]\nversions = ["1"]\n', "[methodology.versions] must be a table"),
    ('headline = "steal_pct"\n', "[[headline]] must be a list of tables"),
    ('headline = [1]\n', "[[headline]] 1 must be a table"),
    ('headline = [["steal_pct"]]\n', "[[headline]] 1 must be a table"),
    ('[[headline]]\nmetric = ["steal_pct"]\n', "headline metric"),
    ('[[headline]]\nmetric = "steal_pct"\nlabel = 3\n', "[[headline]] 1 'label' must be a string"),
    ('[[headline]]\nmetric = "steal_pct"\nhint = ["x"]\n', "[[headline]] 1 'hint' must be a string"),
    ('[[headline]]\nmetric = "steal_pct"\nscenario = "nope"\n', "headline scenario 'nope'"),
    ('[[headline]]\nmetric = "steal_pct"\nscenario = 2\n', "headline scenario '2'"),
])
def test_malformed_presentation_data_is_reported_not_raised(tmp_path, toml, expected):
    assert expected in _presentation(tmp_path, toml)


def test_wellformed_presentation_data_passes(tmp_path):
    assert _presentation(tmp_path, 'ranking_note = "Mixed revisions."\n'
                         '[[compare]]\ntitle = "Pair"\nids = ["x", "y"]\nnote = "Fair."\n'
                         '[methodology]\nroles = { service = "Tool", environment = "" }\n'
                         'checks = [{ check = "c", effect = "e" }]\nlimitations = ["One."]\nversions = { "1" = "First." }\n'
                         '[[headline]]\nmetric = "steal_pct"\nlabel = "Steal"\nhint = ""\n') == ""


def test_ranking_note_is_published(proj, domains, tmp_path):
    publish.build(proj, tmp_path)
    index = json.loads((tmp_path / "index.json").read_text())
    for entry in index["domains"]:
        data = json.loads((tmp_path / f"{entry['id']}.json").read_text())
        assert data["domain"]["ranking_note"] == entry["ranking_note"] == domains[entry["id"]].data.get("ranking_note", "")
    notes = {e["id"]: e["ranking_note"] for e in index["domains"]}
    assert notes["backend"] == ""
    # ts-compilers declares one. It reaches the dataset through to_public() as soon as the domain is published
    # (a domain with status "example" is not).
    assert domains["ts-compilers"].to_public()["ranking_note"].startswith("Mixed TypeScript revisions")


def test_comparisons_and_methodology_are_published(proj, domains, tmp_path):
    """What the website reads to suggest comparisons and to describe a domain's own methodology."""
    publish.build(proj, tmp_path)
    index = json.loads((tmp_path / "index.json").read_text())
    for entry in index["domains"]:
        data = json.loads((tmp_path / f"{entry['id']}.json").read_text())
        d = domains[entry["id"]]
        assert data["domain"]["compare"] == d.data.get("compare", []) == entry["compare"]
        assert data["domain"]["methodology"] == d.data.get("methodology", {}) == entry["methodology"]
        impls = {i["id"] for i in data["implementations"]}
        for c in data["domain"]["compare"]:
            assert set(c["ids"]) <= impls
    # A methodology document the website links to exists in the repository.
    for entry in index["domains"]:
        doc = entry["methodology"].get("document")
        assert doc is None or (ROOT / doc).is_file(), doc


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
    for stat, fake in (("ci95", [1000.0, 1000.0]), ("cv", 0.0), ("min", 999.0), ("outliers", [0])):  # ci95 is None here
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


def _rps(scenarios, value):
    return {sid: {"rps": {"median": value}, "error_rate": {"median": 0.0}} for sid in scenarios}


def test_listed_scenario_missing_for_everybody_withholds_the_index(domains):
    # Every listed scenario is required: the index is never computed over the scenarios that happen to be there.
    d = domains["backend"]
    without_orders = [s for s in SCENARIOS if s != "orders"]
    summary = {"a": _rps(without_orders, 100.0), "b": _rps(without_orders, 50.0)}
    withheld, best = {}, {}
    out = publish.derive(d, summary, withheld, best)
    assert all("throughput_index" not in out.get(i, {}) for i in summary)
    assert withheld["a"]["throughput_index"] == withheld["b"]["throughput_index"] == "Throughput not measured in: orders"
    assert "throughput_index" not in best


def test_listed_scenario_missing_for_one_implementation_withholds_only_its_index(domains):
    d = domains["backend"]
    summary = {"a": _rps(SCENARIOS, 100.0), "b": _rps(SCENARIOS, 50.0),
               "c": _rps([s for s in SCENARIOS if s not in ("db", "list")], 200.0)}
    withheld, best = {}, {}
    out = publish.derive(d, summary, withheld, best)
    assert out["a"]["throughput_index"] == 100 and out["b"]["throughput_index"] == 50
    assert withheld["c"]["throughput_index"] == "Throughput not measured in: db, list"
    assert set(best["throughput_index"]) == set(SCENARIOS)


def test_run_without_any_work_has_no_index_but_a_reason(domains):
    # Everybody measured every listed scenario, and nobody did any work in any of them: every scenario is left
    # out of the index, so there is none. That is not "not measured": every implementation gets the reason.
    d = domains["backend"]
    summary = {"a": _rps(SCENARIOS, 0.0), "b": _rps(SCENARIOS, 0.0)}
    withheld, best = {}, {}
    out = publish.derive(d, summary, withheld, best)
    assert all("throughput_index" not in out.get(i, {}) for i in summary)
    assert withheld["a"]["throughput_index"] == withheld["b"]["throughput_index"] \
        == "Best throughput of zero in every scenario of the index"
    assert "throughput_index" not in best


def test_metric_not_measured_in_the_run_has_no_index_and_no_reason(domains):
    # A run that never measured the metric (e.g. CPU per request in an older run): the site says
    # "not measured in this run"; there is nothing to withhold.
    d = domains["backend"]
    summary = {"a": _rps(SCENARIOS, 100.0), "b": _rps(SCENARIOS, 50.0)}
    withheld, best = {}, {}
    out = publish.derive(d, summary, withheld, best)
    assert out["a"]["throughput_index"] == 100
    assert all("efficiency_index" not in out[i] for i in summary)
    assert all("efficiency_index" not in withheld.get(i, {}) for i in summary)
    assert "efficiency_index" not in best


def test_wildcard_index_spans_the_measured_scenarios():
    from types import SimpleNamespace
    d = SimpleNamespace(
        id="t", data={"derived": [{"id": "speed", "kind": "geomean_relative", "metric": "rps", "scenarios": "*"}]},
        metrics={"rps": SimpleNamespace(better="higher", label="Throughput")})
    summary = {"a": {"x": {"rps": {"median": 100.0}}}, "b": {"x": {"rps": {"median": 50.0}}}}
    withheld = {}
    out = publish.derive(d, summary, withheld)
    assert out == {"a": {"speed": 100}, "b": {"speed": 50}} and withheld == {}


def test_scenario_without_information_is_left_out_for_everybody(domains):
    d = domains["backend"]
    summary = {i: {sid: {"rps": {"median": v}, "error_rate": {"median": 0.0}} for sid in SCENARIOS}
               for i, v in (("a", 100.0), ("b", 25.0))}
    for i in summary:
        summary[i]["list"]["rps"]["median"] = 0.0
    out = publish.derive(d, summary)
    assert out["a"]["throughput_index"] == 100 and out["b"]["throughput_index"] == 25


def test_index_reference_per_scenario_is_published(domains):
    d = domains["backend"]
    summary = {
        "a": {s: {"rps": {"median": 100.0}, "cpu_us_per_req": {"median": 10.0}} for s in SCENARIOS},
        "b": {s: {"rps": {"median": 50.0}, "cpu_us_per_req": {"median": 40.0}} for s in SCENARIOS},
        "fast-but-failing": {s: {"rps": {"median": 900.0}, "error_rate": {"median": 0.5}} for s in SCENARIOS},
    }
    summary["b"]["db"]["rps"]["median"] = 300.0
    best = {}
    publish.derive(d, summary, {}, best)
    assert set(best) == {"throughput_index", "efficiency_index"}  # `max` metrics have no reference
    assert best["throughput_index"]["json"] == {"value": 100.0, "by": ["a"]}
    assert best["throughput_index"]["db"] == {"value": 300.0, "by": ["b"]}
    assert set(best["throughput_index"]) == set(SCENARIOS)
    assert best["efficiency_index"]["orders"] == {"value": 10.0, "by": ["a"]}  # lower is better


def test_index_reference_lists_every_tie(domains):
    d = domains["backend"]
    summary = {i: {s: {"rps": {"median": v}} for s in SCENARIOS} for i, v in (("x", 80.0), ("y", 80.0), ("z", 40.0))}
    best = {}
    publish.derive(d, summary, {}, best)
    assert best["throughput_index"]["queries"] == {"value": 80.0, "by": ["x", "y"]}


def test_scenario_without_information_has_no_reference():
    # Lower is better over a single scenario with valid medians 0 and 5: the scenario carries no information,
    # so there is no index and nobody is crowned for it.
    from types import SimpleNamespace
    d = SimpleNamespace(
        id="t", data={"derived": [{"id": "cost_index", "kind": "geomean_relative", "metric": "cost", "scenarios": ["s"]}]},
        metrics={"cost": SimpleNamespace(better="lower", label="Cost")})
    summary = {"zero": {"s": {"cost": {"median": 0.0}}}, "five": {"s": {"cost": {"median": 5.0}}}}
    best = {}
    out = publish.derive(d, summary, {}, best)
    assert out == {} and best == {}


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
    shutil.copy(ROOT / "benchmania.toml", root / "benchmania.toml")
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
    assert value["n"] == 3 and value["lo"] is None and value["hi"] is None  # three passes: no interval
    assert value["min"] <= value["m"] <= value["max"]


def test_publish_ignores_a_stored_summary(proj, domains, tmp_path):
    """Published numbers are recomputed from the passes; verification refuses an edited summary anyway."""
    d = domains["backend"]
    b = synthetic(d)
    entry = publish._run_entry(d, {**b, "summary": {}}, set())
    first = next(iter(entry["results"]))
    assert entry["results"][first]["db"]["rps"]["m"] == b["summary"][first]["db"]["rps"]["median"]


def test_flags_about_one_metric_name_it(domains):
    """The note about varying throughput belongs to the throughput value, not to memory or latency."""
    d = domains["backend"]
    b = synthetic(d)
    first = next(iter(b["implementations"]))
    b["passes"][0]["results"][first]["scenarios"]["db"]["rps"] *= 2  # one pass far off
    b["passes"][1]["results"][first]["quality"] = {"db": {"flags": ["3 errors (0.10 % of requests)"]}}
    flags = publish._run_entry(d, bundle.finish(b), set())["flags"]
    note = [f for f in flags if f["level"] == "info"]
    assert len(note) == 1 and note[0]["metric"] == "rps" and note[0]["scope"] == f"{first}/db"
    warning = [f for f in flags if f["level"] == "warning"]
    assert len(warning) == 1 and "metric" not in warning[0] and warning[0]["pass"] == 2
    assert note[0]["message"].startswith("throughput varies")


def test_spread_between_passes_is_flagged_for_the_metric_behind_the_index(domains):
    """A domain without throughput gets the note on the metric of its first relative index (compilers: wall time)."""
    d = domains["ts-compilers"]
    metric, label = bundle.varying_metric(d)
    assert (metric, label) == ("wall_ms", d.metrics["wall_ms"].label.lower())
    impls = [i.id for i in d.implementations[:2]]
    sid = d.scenarios[0].id
    passes = [{"index": p, "order": impls, "results": {
        impls[0]: {"scenarios": {sid: {"wall_ms": 300.0 * f, "cpu_ms": 900.0}}},
        impls[1]: {"scenarios": {sid: {"wall_ms": 500.0, "cpu_ms": 900.0 * f}}}}}
        for p, f in enumerate([1.0, 1.4, 0.7], 1)]
    b = {"schema": "benchcore.result/v1", "id": "t", "domain": d.id, "created": "2026-01-01T00:00:00Z",
         "machine": {"id": "m"}, "implementations": {i: {} for i in impls}, "scenarios": {sid: {}},
         "passes": passes, "summary": {}, "quality": {"flags": []}, "options": {}}
    flags = publish._run_entry(d, bundle.finish(b, "complete", d), set())["flags"]
    assert [(f["scope"], f["metric"]) for f in flags] == [(f"{impls[0]}/{sid}", "wall_ms")]
    assert flags[0]["message"].startswith(f"{label} varies")
    assert bundle.finish(b, "complete", d)["quality"]["flags"] == flags  # the bundle stores the same notes


def test_spread_metric_without_an_index_comes_from_the_headline_never_from_throughput(domains):
    """A domain without a relative index: the first headline metric of a scenario; with neither, no spread note."""
    d = copy.copy(domains["ts-compilers"])
    d.data = {k: v for k, v in d.data.items() if k != "derived"}
    assert bundle.varying_metric(d)[0] == "wall_ms"  # first headline entry with a scenario: TypeORM check
    d.data = {**d.data, "headline": [{"metric": "peak_rss_max_mib", "label": "Memory"}]}
    assert bundle.varying_metric(d) == (None, None)
    assert bundle.varying_metric(None) == ("rps", "throughput")
    impls = [i.id for i in d.implementations[:1]]
    sid = d.scenarios[0].id
    passes = [{"index": p, "order": impls, "results": {impls[0]: {"scenarios": {sid: {"wall_ms": 300.0 * f, "rps": 10.0 * f}}}}}
              for p, f in enumerate([1.0, 1.5, 0.6], 1)]
    b = {"schema": "benchcore.result/v1", "id": "t", "domain": d.id, "created": "2026-01-01T00:00:00Z",
         "machine": {"id": "m"}, "implementations": {i: {} for i in impls}, "scenarios": {sid: {}},
         "passes": passes, "summary": {}, "quality": {"flags": []}, "options": {}}
    assert bundle.finish(b, "complete", d)["quality"]["flags"] == []


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
    for name in ("benchmania.toml", "benchmania", "README.md"):
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
