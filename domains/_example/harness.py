"""Example domain harness: run a command in a long-lived container and time it.

Shows everything a domain has to provide: scenario kinds, a functional check and `measure`.
The engine supplies Docker, the CPU layout, statistics, result bundles and publishing.
"""

import statistics
import time

from benchcore import collectors
from benchcore.harness import Harness
from benchcore.layout import cpuset

MIB = 2**20


class CommandHarness(Harness):
    scenario_kinds = {"command": ["command"]}

    def __init__(self, ctx):
        super().__init__(ctx)
        self.defaults = dict(ctx.domain.defaults)
        if ctx.quick:
            self.defaults.update(ctx.domain.data.get("quick", {}))
        self.name = ctx.project.container(ctx.domain.id)  # one container name per domain

    def _start(self, impl):
        svc = self.ctx.domain.service
        self.ctx.docker.run(self.name, self.image_tag(impl), cpuset=cpuset(self.ctx.layout["service"]),
                            cpus=svc.get("cpus"), memory=svc.get("memory"), command=["sleep", "infinity"],
                            extra=["--entrypoint", ""], untrusted=True)
        return collectors.cgroup_of(self.ctx.docker.container_id(self.name))

    def check(self, impl):
        try:
            self._start(impl)
            problems = []
            for s in self.ctx.domain.scenarios:
                out = self.ctx.docker.exec(self.name, *s.params["command"], check=False)
                if out.returncode != 0 or not out.stdout.strip().startswith(s.params.get("expect_stdout", "")):
                    problems.append(f"{s.id}: unexpected output {out.stdout.strip()[:40]!r} (exit {out.returncode})")
            return problems
        except Exception as e:
            return [f"{type(e).__name__}: {e}"]
        finally:
            self.ctx.docker.remove(self.name)

    def measure(self, impl, scenarios, pass_index):
        res = {"scenarios": {}, "quality": {}, "notes": []}
        try:
            cg = self._start(impl)
            for s in scenarios:
                walls, cpus = [], []
                for _ in range(int(self.defaults["repetitions"])):
                    before = collectors.cpu_stat(cg)
                    t0 = time.monotonic()
                    self.ctx.docker.exec(self.name, *s.params["command"])
                    walls.append((time.monotonic() - t0) * 1000)
                    after = collectors.cpu_stat(cg)
                    if before and after:
                        cpus.append((after["usage_usec"] - before["usage_usec"]) / 1000)
                m = {"wall_ms": statistics.median(walls)}
                if cpus:
                    m["cpu_ms"] = statistics.median(cpus)
                mem = collectors.memory_stat(cg)
                if mem and mem.get("peak"):
                    m["peak_mib"] = mem["peak"] / MIB
                res["scenarios"][s.id] = m
                res["quality"][s.id] = {"wall_ms_runs": walls, "flags": []}
        finally:
            self.ctx.docker.remove(self.name)
        return res
