"""ts-compilers harness: type-check and compile pinned TypeScript projects with several compilers.

Images: `prepare` builds a base image (Node.js, Python for the timer, git) and from it one workloads image with
every workloads/<id>/ fetched at its commit and its dependencies installed. Each compiler image is built
FROM the workloads image, so all of them share its layers and every container gets its own writable copy.

Every scenario of every pass runs in a fresh container without network, pinned to the service CPUs (four, or
the first one for the one-core scenarios). Inside, images/tool/timer.py runs the command: untimed warm-up
runs, then the timed repetitions, each timed in the container and verified (diagnostics, exit code, emitted
files). A scenario that fails is left unmeasured with the reason in its quality flags; the others still run.

`check` is the correctness gate: every scenario once, plus each workload with an error seeded into it.
"""

import importlib.util
import json
import statistics
from pathlib import Path

from benchcore import collectors
from benchcore.harness import Harness
from benchcore.layout import cpuset

WORKLOADS_DIR = "/workloads"
OUT_DIR = "/tmp/emit"  # tmpfs in every container, so emit does not depend on the disk
TIMER = "/bench/timer.py"
EMIT_SUFFIXES = (".js", ".d.ts")


def _compilers():
    """Load compilers.py from this directory (domains are not packages, so no plain import)."""
    spec = importlib.util.spec_from_file_location("benchcore_ts_compilers", Path(__file__).with_name("compilers.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C = _compilers()


def _workloads_of(path):
    return C.load_workloads(Path(path) / "workloads")


class CompilerHarness(Harness):
    scenario_kinds = {"compile": ["workload", "mode"]}

    def __init__(self, ctx):
        super().__init__(ctx)
        d = ctx.domain
        self.defaults = dict(d.defaults)
        if ctx.quick:
            self.defaults.update(d.data.get("quick", {}))
        self.workloads = _workloads_of(d.path)
        self.name = ctx.project.container(d.id)
        self.base_tag = ctx.project.container(f"{d.id}-base")
        self.workloads_tag = ctx.project.container(f"{d.id}-workloads")
        self.max_steal = float(ctx.project.run.get("max_steal_percent", 2.0))
        self.max_retries = int(ctx.project.run.get("max_retries", 2))

    # --- static validation ---------------------------------------------------------------------------
    def validate_scenario(self, scenario):
        problems = super().validate_scenario(scenario)
        workloads = _workloads_of(scenario.path.parent.parent)
        problems += [f"{scenario.path}: {p}" for p in C.scenario_problems(scenario.params, workloads)]
        if scenario.params.get("workload") in workloads:
            problems += C.workload_problems(workloads[scenario.params["workload"]])
        return problems

    def validate_implementation(self, impl):
        return C.compiler_problems(impl.data, _workloads_of(impl.path.parent.parent))

    # --- images --------------------------------------------------------------------------------------
    def prepare(self):
        d = self.ctx.docker
        self.ctx.log("building the base and workloads images")
        d.build(self.base_tag, self.ctx.domain.path / "images" / "base")
        dockerfile = self.ctx.workdir / "Dockerfile.workloads"
        dockerfile.write_text(self._workloads_dockerfile(), encoding="utf-8")
        seconds = d.build(self.workloads_tag, self.ctx.domain.path / "workloads", dockerfile)
        self.ctx.log(f"workloads image ready ({', '.join(self.workloads)}; {seconds:.0f} s)")

    def _workloads_dockerfile(self):
        """One stage per workload (each is cached on its own), copied side by side into the final image."""
        lines = []
        for wid, w in self.workloads.items():
            lines += [f"FROM {self.base_tag} AS {wid}",
                      f"COPY {wid}/ /bench/workloads/{wid}/",
                      f"RUN sh /bench/fetch.sh {w['repository']} {w['commit']} {WORKLOADS_DIR}/{wid} "
                      f"&& cd {WORKLOADS_DIR}/{wid} && sh /bench/workloads/{wid}/prepare.sh", ""]
        lines.append(f"FROM {self.base_tag}")
        lines += [f"COPY --from={wid} {WORKLOADS_DIR}/{wid} {WORKLOADS_DIR}/{wid}" for wid in self.workloads]
        return "\n".join(lines) + "\n"

    def build(self, impl):
        tag = self.image_tag(impl)
        c = impl.data["compiler"]
        args = {"WORKLOADS": self.workloads_tag, "PACKAGE": c["package"], "VERSION": impl.data["versions"][c["package"]]}
        seconds = self.ctx.docker.build(tag, impl.path / impl.build.get("context", "."),
                                        impl.path / impl.build.get("dockerfile", "Dockerfile"), args)
        info = self.ctx.docker.image(tag)
        info["build_seconds_cached"] = round(seconds, 2)
        info["workloads"] = {wid: {k: w[k] for k in C.WORKLOAD_KEYS} for wid, w in self.workloads.items()}
        return info

    # --- containers and runs -------------------------------------------------------------------------
    def _cpus(self, s):
        service = self.ctx.layout["service"]
        want = int(s.params.get("cpus", self.ctx.domain.service.get("cpus", len(service))))
        return service[:want], want

    def _start(self, impl, cpus):
        svc = self.ctx.domain.service
        self.ctx.docker.run(self.name, self.image_tag(impl), network="none", cpuset=cpuset(cpus), cpus=len(cpus),
                            memory=svc.get("memory"), command=["sleep", "infinity"],
                            extra=["--entrypoint", "", "--tmpfs", f"{OUT_DIR}:rw,exec"], untrusted=True)

    def _spec(self, impl, s, runs):
        c, w = impl.data["compiler"], self.workloads[s.params["workload"]]
        spec = {"argv": C.command(c, s.params["mode"], w["tsconfig"], OUT_DIR),
                "cwd": f"{WORKLOADS_DIR}/{w['id']}/{w['project']}", "env": c.get("env", {}), "runs": runs}
        if s.params["mode"] == "emit":
            spec.update(clean=OUT_DIR, count=list(EMIT_SUFFIXES))
        return spec

    def _time(self, spec):
        out = self.ctx.docker.exec(self.name, "python3", TIMER, json.dumps(spec)).stdout
        return json.loads(out)

    def _expected(self, impl, s):
        return self.workloads[s.params["workload"]]["expected"][impl.data["compiler"]["typescript"]]

    def _no_network(self):
        """The container must have nothing but loopback (`--network none`)."""
        ifaces = self.ctx.docker.exec(self.name, "ls", "/sys/class/net").stdout.split()
        return [] if ifaces == ["lo"] else [f"measurement container has network interfaces {ifaces}"]

    # --- functional check ----------------------------------------------------------------------------
    def check(self, impl):
        """Every scenario once, then every workload with its seeded error. Problems name the scenario."""
        problems = []
        try:
            for i, s in enumerate(self.ctx.domain.scenarios):
                self._start(impl, self._cpus(s)[0])
                if i == 0:
                    problems += self._no_network()
                run = self._time(self._spec(impl, s, 1))[0]
                problems += [f"{s.id}: {p}" for p in C.run_problems(run, self._expected(impl, s),
                                                                     s.params.get("expect_files"))]
            for wid, w in self.workloads.items():
                seed = w["seeded_error"]
                s = next((s for s in self.ctx.domain.scenarios
                          if s.params["workload"] == wid and s.params["mode"] == "check"), None)
                if s is None:
                    continue
                self._start(impl, self._cpus(s)[0])  # a fresh container: the seeded copy is thrown away with it
                path = f"{WORKLOADS_DIR}/{wid}/{w['project']}/{seed['file']}"
                self.ctx.docker.exec(self.name, "sh", "-c", 'printf "%s" "$1" >> "$2"', "sh", seed["append"], path)
                run = self._time(self._spec(impl, s, 1))[0]
                expected = self._expected(impl, s) + [seed["expect"]]
                problems += [f"{wid} with seeded error: {p}" for p in C.run_problems(run, expected)]
            return problems
        except Exception as e:
            return problems + [f"{type(e).__name__}: {e}"]
        finally:
            self.ctx.docker.remove(self.name)

    # --- measurement ---------------------------------------------------------------------------------
    def measure(self, impl, scenarios, pass_index):
        res = {"scenarios": {}, "quality": {}, "notes": []}
        for s in scenarios:
            try:
                res["scenarios"][s.id], res["quality"][s.id] = self._measure(impl, s)
            except Exception as e:  # this scenario stays unmeasured; the others still run
                reason = f"not measured: {type(e).__name__}: {e}"
                self.ctx.log(f"  {s.id}: {reason[:300]}")
                res["quality"][s.id] = {"flags": [reason[:1500]]}
            finally:
                self.ctx.docker.remove(self.name)
        return res

    def _measure(self, impl, s):
        warmup, reps = int(self.defaults["warmup"]), int(self.defaults["repetitions"])
        cpus, wanted = self._cpus(s)
        spec = self._spec(impl, s, warmup + reps)
        attempts = 1 + self.max_retries
        for attempt in range(1, attempts + 1):
            self._start(impl, cpus)  # fresh container for every attempt
            with collectors.Window({}, freq_cpus=cpus) as w:
                runs = self._time(spec)
            self.ctx.docker.remove(self.name)
            if w.steal is None or w.steal <= self.max_steal or attempt == attempts:
                break
            self.ctx.log(f"  {s.id}: steal {w.steal:.1f} %, repeating ({attempt}/{attempts - 1})")
        expected = self._expected(impl, s)
        for i, run in enumerate(runs):
            problems = C.run_problems(run, expected, s.params.get("expect_files"))
            if problems:
                kind = "warm-up run" if i < warmup else "timed run"
                raise RuntimeError(f"{kind} {i + 1}: " + "; ".join(problems))
        timed = runs[warmup:]
        walls = [round(r["wall_ms"], 3) for r in timed]
        cpu = [round(r["cpu_ms"], 3) for r in timed]
        rss = [round(r["maxrss_kib"] / 1024, 3) for r in timed]
        m = {"wall_ms": statistics.median(walls), "cpu_ms": statistics.median(cpu),
             "peak_rss_mib": statistics.median(rss),
             "parallelism": statistics.median(r["cpu_ms"] / r["wall_ms"] for r in timed)}
        flags = []
        if len(cpus) < wanted:
            flags.append(f"ran on {len(cpus)} CPUs instead of {wanted}: the layout has only {len(cpus)} service CPUs")
        if w.steal is not None:
            m["steal_pct"] = w.steal
            if w.steal > self.max_steal:
                flags.append(f"hypervisor steal {w.steal:.1f} % (limit {self.max_steal} %)")
        if w.load is not None:
            m["host_load"] = w.load
        if w.mhz:
            m["cpu_mhz"] = statistics.fmean(w.mhz)
        q = {"command": spec["argv"], "cwd": spec["cwd"], "env": spec["env"], "cpuset": cpuset(cpus),
             "attempts": attempt, "warmup_runs": warmup, "wall_ms_runs": walls, "cpu_ms_runs": cpu,
             "peak_rss_mib_runs": rss, "warmup_wall_ms": [round(r["wall_ms"], 3) for r in runs[:warmup]], "flags": flags}
        return m, q
