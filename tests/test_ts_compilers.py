"""Pure logic of the ts-compilers domain: diagnostics, the correctness gate and commands from manifests."""

import copy
import importlib.util

import pytest

from benchcore import manifest

from conftest import ROOT

DOMAIN = ROOT / "domains" / "ts-compilers"


def _load(name):
    spec = importlib.util.spec_from_file_location(f"test_ts_compilers_{name}", DOMAIN / f"{name}.py")
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
    assert C.run_problems(run(HONO_71, 2), expected["7.1"]) == []
    assert C.run_problems(run("", 0), expected["7.0"]) == []
    assert C.run_problems(run(HONO_71, 2), expected["7.0"])
    assert C.run_problems(run("", 0), expected["7.1"])


def test_seeded_error_is_compared_by_diagnostic_not_exit_code():
    expected = ["src/util/StringUtils.ts(125,14): error TS2322"]
    assert C.run_problems(run(SEEDED, 2), expected) == []  # tsc 6, 7.1, the ports
    assert C.run_problems(run(SEEDED, 1), expected) == []  # tsc 7.0.2 exits 1
    wrong_column = SEEDED.replace("(125,14)", "(125,15)")
    assert any("unexpected" in p for p in C.run_problems(run(wrong_column, 2), expected))
    assert any("exit code 0" in p for p in C.run_problems(run(SEEDED, 0), expected))


def test_crashes_are_never_valid():
    assert C.run_problems(run("", 0), []) == []
    assert any("exit code 5" in p for p in C.run_problems(run("thread 'main' panicked", 5), []))
    assert C.run_problems(run("", -9), []) == ["killed by signal 9"]
    oom = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n"
    problems = C.run_problems(run(oom, 134), [])
    assert any("exit code 134" in p for p in problems) and any("heap out of memory" in p for p in problems)


def test_emitted_files_are_verified():
    files = {".js": 10, ".d.ts": 10}
    assert C.run_problems(run(files={".js": 10, ".d.ts": 10}), [], files) == []
    assert C.run_problems(run(files={".js": 10, ".d.ts": 9}), [], files) == ["emitted 9 '.d.ts' files, expected 10"]
    assert C.run_problems(run(), [], files)[0] == "emitted None '.js' files, expected 10"


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
    assert domain.implementation("tsrs").data["compiler"]["upstream"] == \
        domain.implementation("tsc-7-1").data["compiler"]["upstream"]


def test_compiler_problems():
    workloads = {"w": {"expected": {"7.1": []}}}
    good = {"versions": {"tsrs": "1.0.0"}, "compiler": {
        "package": "tsrs", "typescript": "7.1", "command": ["tsrs", "-p", "{tsconfig}"],
        "modes": {"check": ["--noEmit"], "single": ["--noEmit"], "emit": ["--outDir", "{out}"]}}}
    assert C.compiler_problems(good, workloads) == []
    bad = copy.deepcopy(good)
    bad["compiler"].update(typescript="7.2", command=["tsrs", "{project}"], env={"A": 1})
    bad["compiler"]["modes"].pop("emit")
    bad["compiler"]["modes"]["fast"] = ["--fast"]
    del bad["versions"]["tsrs"]
    text = "\n".join(C.compiler_problems(bad, workloads))
    for part in ("exact version of 'tsrs'", "modes] emit", "unknown mode 'fast'", "env must map",
                 "unknown placeholder {project}", "workload 'w' declares no expected diagnostics for TypeScript 7.2"):
        assert part in text, part
    assert C.compiler_problems({}, workloads) == ["impl.toml needs a [compiler] table (package, typescript, command, modes)"]


def test_workloads_are_complete():
    workloads = C.load_workloads(DOMAIN / "workloads")
    assert set(workloads) == {"typeorm", "excalidraw"}
    for w in workloads.values():
        assert C.workload_problems(w) == [], w["id"]


def test_workload_problems(tmp_path):
    w = {"id": "x", "path": tmp_path, "title": "X", "repository": "r", "commit": "abc", "project": ".",
         "expected": {"7.1": ["not a diagnostic"]}, "seeded_error": {"file": "a.ts"}}
    text = "\n".join(C.workload_problems(w))
    for part in ("missing 'tsconfig'", "full 40-character commit", "prepare.sh not found", "not a diagnostic",
                 "needs file, append and expect"):
        assert part in text, part


def test_scenario_problems():
    workloads = {"typeorm": {}}
    assert C.scenario_problems({"workload": "typeorm", "mode": "check", "cpus": 4}, workloads) == []
    text = "\n".join(C.scenario_problems({"workload": "nope", "mode": "fast", "cpus": 0,
                                          "expect_files": {".js": 1}}, workloads))
    for part in ("unknown workload 'nope'", "mode must be", "cpus must be", "expect_files"):
        assert part in text, part


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
