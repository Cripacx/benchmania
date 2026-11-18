"""The contract between the engine and a domain.

A domain ships `harness.py` with a subclass of `Harness`. The engine calls, in order:

    validate_scenario / validate_implementation   (static checks, no Docker; used by `validate` and CI)
    prepare()                                     start shared environment (e.g. a database)
    build(impl)                                   build the implementation image, return image facts
    check(impl)                                   functional check; return a list of problems (empty = ok)
    measure(impl, scenarios, pass_index)          one pass over the scenarios for one implementation
    teardown()

`measure` returns {"scenarios": {scenario_id: {metric_id: value, ...}}, "quality": {...}, "notes": [...]}.
Metric ids must exist in the domain's metric registry. Everything else (load generation, cgroups,
statistics, storage, publishing) is provided by the engine through `Context`.
"""

from dataclasses import dataclass, field


@dataclass
class Context:
    project: object
    domain: object
    docker: object
    layout: dict
    options: dict
    workdir: object
    log: object = print
    network: str = None                              # docker network mode every container joins
    env_cgroups: dict = field(default_factory=dict)  # name -> cgroup dir of environment containers

    @property
    def quick(self):
        return bool(self.options.get("quick"))

    def opt(self, key, default=None):
        return self.options.get(key, default)


class Harness:
    #: scenario kinds this harness understands, mapped to required parameter names
    scenario_kinds = {}

    def __init__(self, ctx):
        self.ctx = ctx

    # --- static validation -------------------------------------------------------------------------
    def validate_scenario(self, scenario):
        problems = []
        if scenario.kind not in self.scenario_kinds:
            problems.append(f"{scenario.path}: unknown kind '{scenario.kind}' (known: {sorted(self.scenario_kinds)})")
            return problems
        for key in self.scenario_kinds[scenario.kind]:
            if key not in scenario.params:
                problems.append(f"{scenario.path}: kind '{scenario.kind}' requires '{key}'")
        return problems

    def validate_implementation(self, impl):
        return []

    # --- lifecycle -----------------------------------------------------------------------------------
    def prepare(self):
        pass

    def image_tag(self, impl):
        return self.ctx.project.container(f"{self.ctx.domain.id}-{impl.id}")

    def build(self, impl):
        tag = self.image_tag(impl)
        dockerfile = impl.path / impl.build.get("dockerfile", "Dockerfile")
        context = impl.path / impl.build.get("context", ".")
        seconds = self.ctx.docker.build(tag, context, dockerfile, impl.build.get("args"))
        info = self.ctx.docker.image(tag)
        info["build_seconds_cached"] = round(seconds, 2)
        return info

    def check(self, impl):
        return []

    def measure(self, impl, scenarios, pass_index):
        raise NotImplementedError

    def teardown(self):
        pass
