# Adding a domain

A domain is a self-contained directory: `domains/<id>/`. The engine discovers it automatically; the website
creates pages for it as soon as its status is not `example` (a domain without results gets empty pages).

## 1. Copy the template

```sh
cp -r domains/_example domains/databases
rm -rf domains/databases/__pycache__
```

`_example` times a command in a container. It is small (one harness file, one scenario, two
implementations) and CI runs it end to end, so it always works.

The copy is still the example domain under a new directory name. Before anything else works:

- **`domain.toml`**: set `id` to the directory name (`id = "databases"`). `validate` fails until it matches.
- **`harness.py`**: the class is still called `CommandHarness`. Rename it (for example to
  `DatabaseHarness`) and set `harness = "harness:DatabaseHarness"` in `domain.toml`, or keep the name and
  leave `harness = "harness:CommandHarness"`. The two must match.
- **`scenarios/` and `implementations/`**: they contain the example's `hash` scenario and its `go-crypto` and
  `python-hashlib` implementations. Delete them and add your own (step 5).

## 2. `domain.toml`

```toml
id = "databases"                      # must match the directory name
title = "Databases"
summary = "One sentence shown on the website."
status = "experimental"               # stable | experimental | example (example = not published)
harness = "harness:DatabaseHarness"   # <file>:<class> in this directory
methodology_version = "1"             # a whole number; raise it when results stop being comparable

[service]                             # limits your harness applies to implementation containers
cpus = 2
memory = "2g"

[defaults]                            # anything your harness reads via ctx.domain.defaults
duration = "30s"

[[derived]]                           # optional, computed when publishing
id = "throughput_index"
kind = "geomean_relative"             # or "max"
metric = "ops"
scenarios = ["read", "write"]         # or "*" for every scenario

[[headline]]                          # what the website shows first
scenario = "read"
metric = "ops"
label = "Reads"
hint = "Point reads per second."
```

The example's `[quick]` table is not read by the engine: its harness merges it into the defaults when
`ctx.quick` is set. Keep it if your harness does the same.

## 3. `metrics.toml`

Every metric your harness reports needs an entry. Labels, units, direction and visibility drive the
website; unknown metrics make `validate` fail.

```toml
[ops]
label = "Operations"
unit = "ops/s"
better = "higher"        # higher | lower | neutral
group = "throughput"
decimals = 0             # optional, digits shown on the website
visibility = "primary"   # primary | secondary | diagnostic
description = "Completed operations per second."
```

Replace the example's `wall_ms`, `cpu_ms` and `peak_mib` entries unless your harness reports them, and make
sure every `[[headline]]` and `[[derived]]` metric is listed here.

## 4. `harness.py`

Subclass `benchcore.harness.Harness`, declare `scenario_kinds` (each scenario `kind` mapped to the parameter
names it requires) and implement `check(impl)` and `measure(impl, scenarios, pass_index)` (optionally
`prepare`, `build`, `teardown`, `validate_implementation`). Use the engine's helpers:

- `self.ctx.docker` to build and run containers (`cpuset=cpuset(self.ctx.layout["service"])` with
  `from benchcore.layout import cpuset`, `network=self.ctx.network` to share the runner's network
  namespace, `untrusted=True` for containers that run contributed code),
- `benchcore.collectors` for cgroup CPU/memory/I/O, PSS, steal time and energy (`collectors.Window`),
- `benchcore.loadgen` for HTTP load,
- `self.ctx.quick` to shorten everything in smoke tests.

`measure` returns `{"scenarios": {scenario_id: {metric_id: number}}, "quality": {scenario_id: {"flags": [...]}}, "notes": []}`.
Statistics over passes, bundles, verification and publishing are done for you.

## 5. Scenarios and implementations

Same format as in the backend domain: `scenarios/<id>.toml` (the file name is the scenario id; `title` and a
`kind` from your `scenario_kinds` are required) and `implementations/<id>/impl.toml` with a Dockerfile (the
directory name is the implementation id; `name`, `language` and `category` are required).

## 6. Test

```sh
python -m pytest tests                                         # loads and validates every domain
./benchmania validate                                           # manifests, scenario parameters, bundles
./benchmania check databases                                    # build + functional checks
./benchmania run databases --quick --passes 2 --results .e2e-results   # smoke test, not committed
```

Quick runs are smoke tests: `publish` never includes them. To see the domain with data on the local website,
do a full run (`./benchmania run databases`, which writes to `results/`), then
`./benchmania validate && ./benchmania publish && (cd site && npm ci && npm run dev)`. For a domain whose status
is still `example`, add `--include-examples` to `publish`.
