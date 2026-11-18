# Architecture

## Layers

```
domain manifests  ──►  engine (core/benchcore)  ──►  result bundles  ──►  dataset  ──►  website
(TOML + harness)       runner, collectors,           results/*.json       site/src/data
                       load generators, stats
```

Each layer only knows the documented format of the one before it:

| Layer | Owns | Contract |
|---|---|---|
| Domain | what is measured and how: environment, scenarios, implementations, checks, metric registry | `domain.toml`, `metrics.toml`, `scenarios/*.toml`, `implementations/*/impl.toml`, `harness.py` (a `Harness` subclass) |
| Engine | how runs work: CPU layout, runner container, Docker, cgroup/PSS/steal/energy collectors, wrk/oha, rotation, retries, statistics, bundles, publishing | `core/benchcore/harness.py` (the interface), `core/benchcore/schemas/result-v1.schema.json` |
| Results | the measurements | result bundle `benchcore.result/v1` |
| Website | presentation | dataset `benchcore.dataset/v1` produced by `publish` |

Collection and visualization are decoupled on purpose: a harness may report any metric that exists in its
registry. The dataset carries every summarized metric; the registry's `visibility` (primary, secondary,
diagnostic) only decides what the website shows first.

## The harness interface

```python
class Harness:
    scenario_kinds = {"<kind>": ["required", "params"]}
    def validate_scenario(self, scenario) -> list[str]
    def validate_implementation(self, impl) -> list[str]
    def prepare(self)                                   # shared environment
    def build(self, impl) -> dict                       # default: docker build of the implementation
    def check(self, impl) -> list[str]                  # functional check, [] = ok
    def measure(self, impl, scenarios, pass_index) -> {"scenarios": {id: {metric: value}}, "quality": {...}, "notes": [...]}
    def teardown(self)
```

The engine provides a `Context` with the project, the domain, a Docker wrapper, the CPU layout, the run
options, a scratch directory, a logger and the network mode every container should join. Collectors
(`benchcore.collectors`) and load generators (`benchcore.loadgen`) are plain modules a harness may use.

`domains/_example` is a complete second domain in about 80 lines of harness code; CI runs it end to end to
prove that domains plug in without engine changes.

## Run lifecycle

1. `./machbench run <domain>` (host) builds the runner image and starts it privileged with the host PID and
   cgroup namespaces, the Docker socket and the repository mounted at `/work`.
2. Inside, the engine reads the topology, computes the CPU layout, pins itself to the load-generator CPUs,
   fingerprints the machine and loads the domain harness.
3. `prepare` → `build` + `check` per implementation → passes in rotating order → `measure` per
   implementation → checkpoint the bundle after every implementation → summary and quality flags →
   `teardown`.
4. `./machbench publish` verifies every bundle, computes derived metrics and writes the dataset.

## Identity

The project name, slug and URLs come from `machbench.toml`. Container and image names are derived from the
slug, the website reads the name from the dataset, and `tools/rename_project.py` renames the remaining
plain-text occurrences.

## Decisions

See [docs/adr](adr) for the reasoning behind the monorepo, TOML manifests, the privileged runner and
verifiable bundles.
