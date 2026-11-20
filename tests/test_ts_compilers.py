"""Pure logic of the ts-compilers domain: diagnostics, the correctness gate and commands from manifests."""

import copy
import importlib.util
import re

import pytest

from benchcore import manifest

from conftest import ROOT

DOMAIN = ROOT / "domains" / "ts-compilers"


def _load(name):
    spec = importlib.util.spec_from_file_location(f"test_ts_compilers_{name.replace('/', '_')}",
                                                  DOMAIN / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C = _load("compilers")

# Output of tsc 7.1.0-beta --pretty false on hono at 75ff8e3e (from the feasibility runs): 7.0 reports nothing.
HONO_71 = ("src/helper/css/index.ts(192,31): error TS7031: Binding element 'children' implicitly has an 'any' type.\n"
           "src/helper/css/index.ts(192,41): error TS7031: Binding element 'nonce' implicitly has an 'any' type.\n")
SEEDED = "src/util/StringUtils.ts(125,14): error TS2322: Type 'string' is not assignable to type 'number'.\n"


@pytest.fixture(scope="module")
def domain():
    return manifest.load_all(ROOT)["ts-compilers"]


def run(output="", exit=0, **kw):
    return {"output": output, "exit": exit, **kw}


# --- parsing -----------------------------------------------------------------------------------------------
def test_parse_located_global_and_continuation_lines():
    text = (HONO_71
            + "error TS5107: Option 'moduleResolution=node10' is deprecated.\n"
            + "src/a.ts(1,2): error TS2345: Argument of type 'X' is not assignable.\n"
            + "  Type 'X' is missing the following properties: a, b\n"
            + "thread 'main' panicked at src/checker.rs:12:5\n"
            + "\n")
    assert C.parse_diagnostics(text) == [
        "src/helper/css/index.ts(192,31): error TS7031",
        "src/helper/css/index.ts(192,41): error TS7031",
        "error TS5107",
        "src/a.ts(1,2): error TS2345",
    ]


def test_parse_handles_crlf_and_paths_with_parentheses():
    text = "packages/x (copy)/a.tsx(3,7): error TS2322: m\r\n"
    assert C.parse_diagnostics(text) == ["packages/x (copy)/a.tsx(3,7): error TS2322"]


def test_normalize_rejects_messages_and_garbage():
    assert C.normalize(" src/a.ts(1,2): error TS2322 ") == "src/a.ts(1,2): error TS2322"
    assert C.normalize("error TS5107") == "error TS5107"
    for bad in ("src/a.ts(1,2): error TS2322: with message", "src/a.ts: error TS1", "TS2322"):
        with pytest.raises(ValueError):
            C.normalize(bad)


# --- comparison and the gate -------------------------------------------------------------------------------
def test_compare_ignores_order_but_counts_duplicates():
    expected = ["src/helper/css/index.ts(192,41): error TS7031", "src/helper/css/index.ts(192,31): error TS7031"]
    assert C.compare(expected, C.parse_diagnostics(HONO_71)) == []
    problems = C.compare(expected + expected[:1], C.parse_diagnostics(HONO_71))
    assert problems == ["1 expected diagnostic(s) missing: src/helper/css/index.ts(192,41): error TS7031"]
    problems = C.compare([], C.parse_diagnostics(HONO_71))
    assert problems[0].startswith("2 unexpected diagnostic(s): src/helper/css/index.ts(192,31)")


def test_expectations_are_per_typescript_line():
    """The mechanism the gate relies on: the same output is right for 7.1 and wrong for 7.0."""
    expected = {"7.0": [], "7.1": ["src/helper/css/index.ts(192,31): error TS7031",
                                   "src/helper/css/index.ts(192,41): error TS7031"]}
    assert C.run_problems(run(HONO_71, 2), expected["7.1"], 2) == []
    assert C.run_problems(run("", 0), expected["7.0"], 2) == []
    assert C.run_problems(run(HONO_71, 2), expected["7.0"], 2)
    assert C.run_problems(run("", 0), expected["7.1"], 2)


def test_seeded_error_needs_the_diagnostic_and_the_tools_exact_exit_code():
    expected = ["src/util/StringUtils.ts(125,14): error TS2322"]
    assert C.run_problems(run(SEEDED, 2), expected, 2) == []  # tsc 6, 7.1, the ports
    assert C.run_problems(run(SEEDED, 1), expected, 1) == []  # tsc 7.0.2 exits 1
    assert C.run_problems(run(SEEDED, 1), expected, 2)[0] == "exit code 1 where 2 was expected"
    wrong_column = SEEDED.replace("(125,14)", "(125,15)")
    assert any("unexpected" in p for p in C.run_problems(run(wrong_column, 2), expected, 2))
    assert any("exit code 0" in p for p in C.run_problems(run(SEEDED, 0), expected, 2))


def test_a_crash_after_the_expected_diagnostics_is_not_valid():
    """The diagnostics were printed, then the process died: only the exit code shows it."""
    expected = ["src/util/StringUtils.ts(125,14): error TS2322"]
    crash = SEEDED + "thread 'main' panicked at src/checker.rs:12:5\n"
    problems = C.run_problems(run(crash, 101), expected, 2)
    assert problems[0] == "exit code 101 where 2 was expected" and "panicked" in problems[-1]
    assert C.run_problems(run(SEEDED, 134), expected, 2)[0] == "exit code 134 where 2 was expected"


def test_crashes_are_never_valid():
    assert C.run_problems(run("", 0), [], 2) == []
    assert any("exit code 5" in p for p in C.run_problems(run("thread 'main' panicked", 5), [], 2))
    assert C.run_problems(run("", -9), [], 2) == ["killed by signal 9"]
    oom = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n"
    problems = C.run_problems(run(oom, 134), [], 2)
    assert any("exit code 134" in p for p in problems) and any("heap out of memory" in p for p in problems)


def test_a_process_left_behind_makes_the_run_invalid():
    assert C.run_problems(run(leftover=[]), [], 2) == []
    problems = C.run_problems(run(leftover=["17 tsgo Z"]), [], 2)
    assert problems == ["processes still present after the command returned: 17 tsgo Z"]


def test_emitted_files_are_verified():
    files = {".js": 10, ".d.ts": 10}
    assert C.run_problems(run(files={".js": 10, ".d.ts": 10}), [], 2, files) == []
    assert C.run_problems(run(files={".js": 10, ".d.ts": 9}), [], 2, files) == ["emitted 9 '.d.ts' files, expected 10"]
    assert C.run_problems(run(), [], 2, files)[0] == "emitted None '.js' files, expected 10"


# --- commands and manifests --------------------------------------------------------------------------------
def test_command_is_built_from_the_manifest(domain):
    c = domain.implementation("tsc-7-1").data["compiler"]
    assert C.command(c, "single", "tsconfig.bench.json", "/out") == [
        "tsc", "-p", "tsconfig.bench.json", "--incremental", "false", "--composite", "false", "--pretty", "false",
        "--noEmit", "--singleThreaded"]
    assert C.command(c, "emit", "t.json", "/tmp/emit")[-3:] == ["--outDir", "/tmp/emit", "--declaration"]
    tsc6 = domain.implementation("tsc-6-0").data["compiler"]
    assert C.command(tsc6, "single", "t.json", "/o") == C.command(tsc6, "check", "t.json", "/o")


def test_every_implementation_is_published_with_its_commands(domain):
    for impl in domain.implementations:
        public = impl.to_public()
        assert public["compiler"]["command"] and set(public["compiler"]["modes"]) == set(C.MODES)
        assert public["versions"][public["compiler"]["package"]], impl.id
        assert "build" not in public


def test_ports_and_prereleases_say_so(domain):
    for iid in ("tsrs", "tsc-rs"):
        impl = domain.implementation(iid)
        assert "experimental" in impl.data["variant"]
        assert impl.data["compiler"]["upstream"].startswith("microsoft/TypeScript@")
    assert "beta" in domain.implementation("tsc-7-1").name
    assert domain.implementation("tsc-7-1").data["variant"] == "pre-release"
    assert domain.implementation("tsrs").data["compiler"]["upstream"] == \
        domain.implementation("tsc-7-1").data["compiler"]["upstream"]


def test_compiler_problems():
    workloads = {"w": {"expected": {"7.1": []}}}
    good = {"versions": {"tsrs": "1.0.0"}, "compiler": {
        "package": "tsrs", "typescript": "7.1", "error_exit": 2, "command": ["tsrs", "-p", "{tsconfig}"],
        "modes": {"check": ["--noEmit"], "single": ["--noEmit"], "emit": ["--outDir", "{out}"]}}}
    assert C.compiler_problems(good, workloads) == []
    bad = copy.deepcopy(good)
    bad["compiler"].update(typescript="7.2", command=["tsrs", "{project}"], env={"A": 1})
    bad["compiler"]["modes"].pop("emit")
    bad["compiler"]["modes"]["fast"] = ["--fast"]
    del bad["versions"]["tsrs"]
    del bad["compiler"]["error_exit"]
    text = "\n".join(C.compiler_problems(bad, workloads))
    for part in ("exact version of 'tsrs'", "error_exit must be", "modes] emit", "unknown mode 'fast'", "env must map",
                 "unknown placeholder {project}", "workload 'w' declares no expected diagnostics for TypeScript 7.2"):
        assert part in text, part
    per_mode = {**good, "compiler": {**good["compiler"], "error_exit": {"check": 1, "single": 1, "emit": 2}}}
    assert C.compiler_problems(per_mode, workloads) == []
    assert C.error_exit(per_mode["compiler"], "emit") == 2 and C.error_exit(good["compiler"], "emit") == 2
    for code in (0, 256, "2", True, {"check": 1, "emit": 2}, {"check": 1, "single": 1, "emit": 0}):
        assert any("error_exit" in p for p in C.compiler_problems(
            {**good, "compiler": {**good["compiler"], "error_exit": code}}, workloads)), code
    assert C.compiler_problems({}, workloads) == ["impl.toml needs a [compiler] table (package, typescript, command, modes)"]


def test_workloads_are_complete():
    workloads = C.load_workloads(DOMAIN / "workloads")
    assert set(workloads) == {"typeorm", "excalidraw"}
    for w in workloads.values():
        assert C.workload_problems(w) == [], w["id"]
        seeds = w["seeded_errors"]
        assert 6 <= len(seeds) <= 8, w["id"]
        # spread over the project: every seed in a directory of its own
        assert len({s["file"].rsplit("/", 1)[0] for s in seeds}) == len(seeds), w["id"]
        names = [re.search(r"export (?:const|function|type|class) (\w+)", s["append"])[1] for s in seeds]
        assert len(set(names)) == len(names) and all(n.lower().startswith("benchseed") for n in names), names
        for s in seeds:
            assert s["append"].startswith("\n") and s["append"].endswith("\n"), s["file"]
            assert set(s["expect"]) == set(w["expected"]), s["file"]
    tsx = [s for s in workloads["excalidraw"]["seeded_errors"] if s["file"].endswith(".tsx")]
    assert tsx and all("<Tooltip" in s["append"] for s in tsx)  # errors in JSX props


def test_seeded_expected_adds_every_seed_to_the_expected_diagnostics():
    w = {"expected": {"7.1": ["a.ts(1,1): error TS1"]},
         "seeded_errors": [{"expect": {"7.1": ["b.ts(2,1): error TS2", "b.ts(2,5): error TS3"]}},
                           {"expect": {"7.1": ["c.ts(3,1): error TS4"]}}]}
    assert C.seeded_expected(w, "7.1") == ["a.ts(1,1): error TS1", "b.ts(2,1): error TS2", "b.ts(2,5): error TS3",
                                           "c.ts(3,1): error TS4"]


def _seed(**kw):
    return {"intent": "TS2322", "file": "src/a.ts", "append": "\nexport const benchSeedA: number = \"\"\n",
            "expect": {"7.0": ["src/a.ts(3,14): error TS2322"], "7.1": ["src/a.ts(3,14): error TS2322"]}, **kw}


def test_workload_problems(tmp_path):
    w = {"id": "x", "path": tmp_path, "title": "X", "repository": "r", "commit": "abc", "project": ".",
         "expected": {"7.1": ["not a diagnostic"]}, "seeded_errors": [{"file": "a.ts"}]}
    text = "\n".join(C.workload_problems(w))
    for part in ("missing 'tsconfig'", "full 40-character commit", "prepare.sh not found", "not a diagnostic",
                 "needs intent, file and append"):
        assert part in text, part
    for seeds in ({"seeded_errors": []}, {"seeded_errors": None, "seeded_error": _seed()}):
        assert any("must list the errors seeded" in p for p in C.workload_problems({**w, **seeds})), seeds


def test_seed_problems():
    expected = {"7.0": [], "7.1": []}
    good = _seed()
    assert C._seed_problems("w", [good], expected) == []
    cases = {
        "expects nothing for TypeScript 7.0": _seed(expect={"7.1": good["expect"]["7.1"]}),
        "must list at least one diagnostic": _seed(expect={**good["expect"], "7.0": []}),
        "is not in src/a.ts": _seed(expect={**good["expect"], "7.0": ["src/b.ts(3,14): error TS2322"]}),
        "not a diagnostic": _seed(expect={**good["expect"], "7.0": ["src/a.ts: TS2322"]}),
        "append must start with a newline": _seed(append="export const benchSeedA = 1\n"),
        "needs [seeded_errors.expect]": _seed(expect=None),
        "needs intent, file and append": _seed(intent=""),
    }
    for part, seed in cases.items():
        assert any(part in p for p in C._seed_problems("w", [seed], expected)), part
    assert C._seed_problems("w", [good, good], expected) == [
        "w: 2 seeded errors in src/a.ts; each must have a file of its own"]


def test_scenario_problems():
    workloads = {"typeorm": {}}
    assert C.scenario_problems({"workload": "typeorm", "mode": "check", "cpus": 4}, workloads) == []
    text = "\n".join(C.scenario_problems({"workload": "nope", "mode": "fast", "cpus": 0,
                                          "expect_files": {".js": 1}}, workloads))
    for part in ("unknown workload 'nope'", "mode must be", "cpus must be", "expect_files"):
        assert part in text, part
    emit = {"workload": "typeorm", "mode": "emit"}
    assert C.scenario_problems({**emit, "expect_files": {".js": 3, ".d.ts": 3}}, workloads) == []
    assert "an emit scenario needs expect_files" in C.scenario_problems(emit, workloads)[0]
    for files in ({}, {".js": 0}, {".js": "3"}, {".js": True}):
        assert C.scenario_problems({**emit, "expect_files": files}, workloads), files


def test_every_emit_scenario_verifies_its_output(domain):
    emit = [s for s in domain.scenarios if s.params["mode"] == "emit"]
    assert emit and all(s.params["expect_files"] for s in emit)


def test_workloads_dockerfile_has_one_stage_per_workload():
    H = _load("harness")
    h = H.CompilerHarness.__new__(H.CompilerHarness)
    h.base_tag = "bench-ts-compilers-base"
    h.workloads = C.load_workloads(DOMAIN / "workloads")
    text = h._workloads_dockerfile()
    for wid, w in h.workloads.items():
        assert f"FROM bench-ts-compilers-base AS {wid}\n" in text
        assert f"sh /bench/fetch.sh {w['repository']} {w['commit']} /workloads/{wid} " in text
        assert f"COPY --from={wid} /workloads/{wid} /workloads/{wid}\n" in text
    assert text.count("\nFROM bench-ts-compilers-base\n") == 1


def test_a_failing_scenario_is_left_unmeasured_and_the_others_still_run(domain):
    """measure() catches failures per scenario: the reason goes to that scenario's quality flags."""
    H = _load("harness")

    class FakeDocker:
        removed = 0

        def remove(self, name):
            FakeDocker.removed += 1

    class FakeCtx:
        docker = FakeDocker()

        @staticmethod
        def log(msg):
            pass

    h = H.CompilerHarness.__new__(H.CompilerHarness)
    h.ctx, h.name = FakeCtx(), "c"

    def fake_measure(impl, s):
        if s.id == "typeorm-emit":
            raise RuntimeError("timed run 2: 1 unexpected diagnostic(s): src/a.ts(1,1): error TS2322")
        return {"wall_ms": 1.0}, {"flags": []}

    h._measure = fake_measure
    res = h.measure(domain.implementation("tsrs"), domain.scenarios, 1)
    assert set(res["scenarios"]) == {s.id for s in domain.scenarios} - {"typeorm-emit"}
    assert res["quality"]["typeorm-emit"]["flags"][0].startswith("not measured: RuntimeError: timed run 2:")
    assert FakeDocker.removed == len(domain.scenarios)  # no container outlives its scenario


class _Docker:
    def __init__(self):
        self.execs = []

    def remove(self, name):
        pass

    def exec(self, name, *cmd):
        self.execs.append(cmd)


def _harness(domain, steal=0.0):
    H = _load("harness")
    h = H.CompilerHarness.__new__(H.CompilerHarness)
    h.ctx = type("Ctx", (), {"docker": _Docker(), "domain": domain, "log": staticmethod(lambda msg: None)})()
    h.name, h.defaults, h.max_steal, h.max_retries = "c", {"warmup": 1, "repetitions": 2}, 2.0, 2
    h.workloads = C.load_workloads(DOMAIN / "workloads")
    h._cpus = lambda s: (["0"], 1)
    h._start = lambda impl, cpus: None
    h._environment_problems = lambda: []

    class Window:
        def __init__(self, *a, **kw):
            self.steal, self.load, self.mhz = steal, None, []

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    return H, h, Window


def test_an_attempt_repeated_for_steal_is_verified_first(domain, monkeypatch):
    """High steal and a bad run in the first attempt: the scenario is unmeasured, not silently retried."""
    H, h, Window = _harness(domain, steal=9.0)
    monkeypatch.setattr(H.collectors, "Window", Window)
    calls = []

    def fake_time(spec):
        calls.append(spec)
        return [run("", 0, wall_ms=1.0, cpu_ms=1.0, maxrss_kib=1024)] * 2 + [run("", 134, wall_ms=1.0)]

    h._time = fake_time
    s = next(s for s in domain.scenarios if s.id == "typeorm-check")
    with pytest.raises(RuntimeError, match=r"^attempt 1, timed run 3: exit code 134 where 0 was expected"):
        h._measure(domain.implementation("tsrs"), s)
    assert len(calls) == 1

    good = [run("", 0, wall_ms=2.0, cpu_ms=3.0, maxrss_kib=2048)] * 3
    h._time = lambda spec: calls.append(spec) or good
    m, q = h._measure(domain.implementation("tsrs"), s)  # good runs, high steal: retried, then flagged
    assert len(calls) == 1 + 3 and q["attempts"] == 3 and m["wall_ms"] == 2.0
    assert any("hypervisor steal" in f for f in q["flags"])


def _diagnostics(keys):
    return "".join(f"{k}: message\n" for k in keys)


def _checked(domain, impl, found):
    """check() with a fake tool that reports `found(workload)` once every seed of the workload is in its
    container, and nothing before. Returns (problems, appended files per container)."""
    H, h, _ = _harness(domain)
    containers = []
    h._start = lambda impl, cpus: containers.append([])

    def exec_(name, *cmd):
        assert cmd[:2] == ("sh", "-c") and cmd[2].startswith('test -f "$2" && ')
        containers[-1].append(cmd[-1])

    h.ctx.docker.exec = exec_

    def fake_time(spec):
        w = h.workloads[spec["cwd"].split("/")[2]]
        files = {".js": 3287, ".d.ts": 3287}
        if len(containers[-1]) == len(w["seeded_errors"]):
            mode = "emit" if "--outDir" in spec["argv"] else "check"
            return [run(_diagnostics(found(w)), C.error_exit(impl.data["compiler"], mode), files=files)]
        return [run("", 0, files=files)]

    h._time = fake_time
    return h.check(impl), containers


def test_check_appends_every_seed_and_expects_all_of_them(domain):
    impl = domain.implementation("tsc-7-0")
    line = impl.data["compiler"]["typescript"]
    problems, containers = _checked(domain, impl, lambda w: C.seeded_expected(w, line))
    assert problems == []
    assert len(containers) == len(domain.scenarios)  # one container per scenario, seeds thrown away with it
    for s, appended in zip(domain.scenarios, containers):
        w = C.load_workloads(DOMAIN / "workloads")[s.params["workload"]]
        assert appended == [f"/workloads/{w['id']}/{w['project']}/{seed['file']}" for seed in w["seeded_errors"]]

    # a tool that misses one seed fails every scenario, and the problem names the missing diagnostic
    problems, _ = _checked(domain, impl, lambda w: C.seeded_expected(w, line)[1:])
    assert len(problems) >= len(domain.scenarios) and all(" with seeded errors: " in p for p in problems)
    assert any("1 expected diagnostic(s) missing" in p for p in problems)


def test_timer_reports_processes_left_behind(tmp_path):
    T = _load("images/tool/timer")
    for pid, stat in ((1, "1 (sleep) S 0 1"), (40, "40 (python3) R 0 40"), (41, "41 (tsgo (x)) Z 1 41")):
        (tmp_path / str(pid)).mkdir()
        (tmp_path / str(pid) / "stat").write_text(stat, encoding="utf-8")
    (tmp_path / "self").mkdir()
    (tmp_path / "99").mkdir()  # exited while being read: no stat file
    after = T.processes(str(tmp_path))
    assert after == {1: "1 sleep S", 40: "40 python3 R", 41: "41 tsgo (x) Z"}
    assert T.leftover({1: "1 sleep S"}, after, 40) == ["41 tsgo (x) Z"]
    assert T.leftover({1: "1 sleep S"}, {1: "1 sleep S", 40: "40 python3 R"}, 40) == []
