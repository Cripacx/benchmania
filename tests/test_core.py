"""Unit tests for the engine: units, statistics, CPU layout, load-generator parsing, run rotation."""

import json
from pathlib import Path

import pytest

from benchcore import layout, loadgen, runner, stats, units


def test_units():
    assert units.seconds("15s") == 15
    assert units.seconds("500ms") == 0.5
    assert units.seconds("2m") == 120
    assert units.seconds(3) == 3.0
    assert units.size_bytes("1g") == 1024**3
    assert units.size_bytes("512MiB") == 512 * 1024**2
    assert units.docker_duration("0.4s") == "1s"
    with pytest.raises(ValueError):
        units.seconds("fast")


def test_summarize_and_outliers():
    s = stats.summarize([100, 102, 98, 101, 300])
    assert s["median"] == 101
    assert s["n"] == 5
    assert s["outliers"] == [4]
    assert s["ci95"][0] <= s["median"] <= s["ci95"][1]
    assert stats.summarize([None, float("nan")]) is None
    assert stats.summarize([5])["iqr"] == [5, 5]


def test_no_confidence_interval_below_five_values():
    # [min, max] of 3 or 4 values covers the median with 75 % or 87.5 %: not a 95 % interval
    for values in ([5], [5, 7], [5, 7, 6], [5, 7, 6, 8]):
        assert stats.summarize(values)["ci95"] is None, values
    assert stats.summarize([5, 7, 6, 8, 9])["ci95"] == [5, 9]  # 93.75 % for five values


def test_bootstrap_is_deterministic():
    v = [10.0, 11.5, 9.8, 10.4, 10.9]
    assert stats.bootstrap_ci(v) == stats.bootstrap_ci(v)


def test_geomean():
    assert stats.geomean([1, 4]) == pytest.approx(2)
    assert stats.geomean([]) is None


def six_core_smt_topology():
    # 6 cores with SMT, siblings numbered n and n+6 (typical Intel numbering)
    return [(c, (0, c % 6)) for c in range(12)]


def test_layout_isolates_service_siblings():
    plan = layout.plan(six_core_smt_topology(), service_cpus=2)
    assert plan["service"] == [0, 1]
    assert plan["idle"] == [6, 7]
    assert sorted(plan["environment"]) == [2, 3, 8, 9]
    assert sorted(plan["loadgen"]) == [4, 5, 10, 11]
    assert plan["smt"] and not plan["warnings"]


def test_layout_without_smt():
    plan = layout.plan([(c, (0, c)) for c in range(8)], service_cpus=2)
    assert plan["service"] == [0, 1]
    assert plan["environment"] == [2, 3, 4]
    assert plan["loadgen"] == [5, 6, 7]


def test_layout_small_machine_warns():
    plan = layout.plan([(0, (0, 0)), (1, (0, 1))], service_cpus=2)
    assert plan["warnings"]


def test_layout_override():
    plan = layout.parse_override("service=0,1;environment=2-3;loadgen=4-7", known=range(8))
    assert plan["loadgen"] == [4, 5, 6, 7]
    assert plan["warnings"] == ["manual layout"]
    with pytest.raises(ValueError, match="unknown role"):
        layout.parse_override("gpu=1")
    with pytest.raises(ValueError, match="needs CPUs for: environment"):  # would run unpinned on the service cores
        layout.parse_override("service=0,1;loadgen=2-3")
    with pytest.raises(ValueError, match="not available: 8,9"):
        layout.parse_override("service=0,1;environment=2;loadgen=8-9", known=range(8))
    shared = layout.parse_override("service=0,1;environment=1,2;loadgen=3")
    assert any("service and environment share CPUs 1" in w for w in shared["warnings"])


def fake_sysfs(tmp_path, cpus):
    """cpus: {cpu: (package, core_id, siblings or None, online)}"""
    for cpu, (pkg, core_id, siblings, online) in cpus.items():
        topo = tmp_path / f"cpu{cpu}" / "topology"
        topo.mkdir(parents=True)
        (topo / "physical_package_id").write_text(f"{pkg}\n")
        (topo / "core_id").write_text(f"{core_id}\n")
        if siblings:
            (topo / "core_cpus_list").write_text(siblings + "\n")
        (tmp_path / f"cpu{cpu}" / "online").write_text("1\n" if online else "0\n")
    (tmp_path / "cpufreq").mkdir()  # not a CPU directory
    return tmp_path


def test_topology_groups_by_sibling_list(tmp_path):
    smt = fake_sysfs(tmp_path / "smt", {c: (0, c % 2, f"{c % 2},{c % 2 + 2}", True) for c in range(4)})
    assert layout.read_topology(smt) == [(0, (0, 0)), (1, (0, 1)), (2, (0, 0)), (3, (0, 1))]
    # big.LITTLE: core_id restarts in the second cluster, but these are eight separate cores
    arm = fake_sysfs(tmp_path / "arm", {c: (0, c % 4, str(c), True) for c in range(8)})
    assert len({key for _, key in layout.read_topology(arm)}) == 8
    assert not layout.plan(layout.read_topology(arm))["smt"]
    offline = fake_sysfs(tmp_path / "off", {0: (0, 0, "0", True), 1: (0, 1, "1", False), 2: (0, 2, "2", True)})
    assert [cpu for cpu, _ in layout.read_topology(offline)] == [0, 2]
    bare = fake_sysfs(tmp_path / "bare", {c: (0, 0, None, True) for c in range(2)})  # no sibling files at all
    assert len({key for _, key in layout.read_topology(bare)}) == 2


def test_parse_wrk_report():
    line = loadgen.MARK + json.dumps({
        "requests": 1000, "duration_us": 2_000_000, "bytes": 150_000,
        "errors": {"connect": 0, "read": 0, "write": 0, "status": 5, "timeout": 0},
        "latency_us": {"min": 100, "max": 9000, "mean": 1500.0, "stdev": 200.0, "p50": 1400, "p75": 1600,
                       "p90": 1800, "p99": 2500, "p99_9": 5000, "p99_99": 8000}})
    r = loadgen.parse_wrk("Running 2s test\n" + line + "\n")
    assert r["rps"] == 497.5  # 995 successful responses in 2 s: error responses are not throughput
    assert r["errors"] == 5
    assert r["error_rate"] == 0.005
    assert r["bytes_per_resp"] == 150
    assert r["latency_p99_ms"] == 2.5
    assert r["latency_p99_9_ms"] == 5.0
    with pytest.raises(ValueError):
        loadgen.parse_wrk("no report")


def test_parse_oha_report():
    doc = {"summary": {"successRate": 1.0, "total": 15.0, "requestsPerSec": 5000.0, "average": 0.0007,
                       "slowest": 0.015, "sizePerRequest": 31},
           "latencyPercentiles": {"p50": 0.00066, "p75": 0.0008, "p90": 0.001, "p99": 0.00173, "p99.9": 0.00373,
                                  "p99.99": 0.006},
           "statusCodeDistribution": {"200": 74990, "500": 10},
           "errorDistribution": {"aborted due to deadline": 3}}
    r = loadgen.parse_oha(json.dumps(doc))
    assert r["rps"] == pytest.approx(74990 / 15)  # successful responses only
    assert r["errors"] == 10  # requests cut off by oha at the end of the run are not service errors
    assert r["requests"] == 75000
    assert r["latency_p99_ms"] == pytest.approx(1.73)
    assert r["latency_p99_9_ms"] == pytest.approx(3.73)


def test_wrk_script_escapes_body():
    script = loadgen.wrk_script("POST", '{"a":"b\\c"}', {"Content-Type": "application/json"})
    assert 'wrk.method = "POST"' in script
    assert 'wrk.body = "{\\"a\\":\\"b\\\\c\\"}"' in script
    assert "done = function" in script


@pytest.mark.parametrize("n", [2, 3, 10, 15, 16])
def test_rotation_varies_position_and_predecessor(n):
    items = [f"impl{i}" for i in range(n)]
    passes = min(5, n)
    orders = [runner.rotation(items, p, passes) for p in range(passes)]
    for order in orders:
        assert sorted(order) == sorted(items)
    for item in items:
        positions = {order.index(item) for order in orders}
        assert len(positions) == passes, f"{item} keeps a position"
        before = [order[order.index(item) - 1] for order in orders if order.index(item) > 0]
        # an odd number of implementations cannot avoid one repeated neighbour in the base order
        assert len(set(before)) >= len(before) - 1, f"{item} keeps running after the same implementation"
    assert runner.rotation([], 0, 5) == []


@pytest.mark.parametrize("system, security, suitable", [
    ("Linux", [], True),
    ("Linux", ["name=rootless"], False),
    # Docker Desktop reports a Linux engine with cgroup v2 on Windows and macOS
    ("Windows", [], False),
    ("Darwin", [], False),
])
def test_doctor_accepts_only_linux_with_rootful_docker(monkeypatch, capsys, system, security, suitable):
    from types import SimpleNamespace
    from benchcore import cli, docker

    class FakeDocker:
        def __init__(self, label):
            pass

        def available(self):
            return "27.0.0"

        def info(self):
            return {"CgroupVersion": "2", "CgroupDriver": "cgroupfs", "SecurityOptions": security, "NCPU": 8, "MemTotal": 2**34}

    monkeypatch.setattr(docker, "Docker", FakeDocker)
    monkeypatch.setattr(cli.platform, "system", lambda: system)
    monkeypatch.setattr(layout, "read_topology", lambda: None)
    assert cli.cmd_doctor(SimpleNamespace(label="test"), None) == (0 if suitable else 1)
    assert ("measuring needs Linux" in capsys.readouterr().out) is (system != "Linux")


def test_shown_path_is_relative_below_the_working_directory_and_absolute_otherwise(tmp_path):
    from types import SimpleNamespace
    inside = tmp_path / "work"  # where the runner sees the checkout
    host = tmp_path / "home" / "checkout"  # where the user's checkout really is
    proj = SimpleNamespace(root=inside, repository="https://example.org/org/repo/")
    bundle_file = inside / "results" / "backend" / "m1" / "r1.json"
    assert runner.shown_path(bundle_file, proj, host, host) == str(Path("results/backend/m1/r1.json"))
    assert runner.shown_path(bundle_file, proj, host, host / "results") == str(Path("backend/m1/r1.json"))
    assert runner.shown_path(bundle_file, proj, host, tmp_path / "elsewhere") == str(host / "results/backend/m1/r1.json")
    assert runner.submit_hint(proj).endswith("https://example.org/org/repo/blob/main/docs/guides/submitting-results.md")
