# Benchmania

**Community-driven, reproducible performance benchmarks.** Benchmania measures how software performs under
realistic, controlled conditions. Anyone can contribute implementations, benchmark domains and measurements
from their own hardware; every number is published with the hardware, versions and raw data behind it.

The first domain is **backend services**: the same HTTP API with a PostgreSQL database, implemented in Go,
Rust, C# (.NET 10 and 11, JIT and Native AOT), Java (Spring Boot on the JVM, with an AOT cache and as a
GraalVM native image), TypeScript (Node.js with Fastify and Express, Bun), Python (FastAPI), PHP (FrankenPHP)
and Elixir. Every implementation runs in the same small container — 2 CPU cores and 1 GiB of memory, like a
production pod — and is measured in eleven scenarios: cold start, warm-up, JSON, single and multiple
queries, updates, a list endpoint, a JSON POST, low and high concurrency, and latency at a fixed request rate.

The platform is built so that new **domains** (databases, compute kernels, frontends, AI inference, …),
**scenarios** and **implementations** can be added without touching the engine, and so that anyone can run
the suite on their own hardware and contribute results.

## Community-driven

Benchmania is run by its contributors. Implementations, domains and measurements all arrive as pull requests;
changes to the engine, the harnesses and the list of reference runs are reviewed by the maintainers, and
methodology problems are discussed in public issues. Every published run is labelled with who measured it:
**reference** for runs the maintainers measured themselves, **community** for every other merged run. There
are no community runs yet, so a measurement from other hardware is the most useful contribution right now.

To add a measurement from your machine (Linux with rootful Docker and cgroup v2, see the requirements below):

```sh
./benchmania doctor                                # is this machine suitable?
./benchmania check backend                         # every implementation must pass
./benchmania run backend --label "My workstation"  # several hours; writes results/backend/<machine>/<run>.json
./benchmania validate
```

Then open a pull request that adds only that bundle file. [CONTRIBUTING.md](CONTRIBUTING.md) explains the
review, and [Submitting results](docs/guides/submitting-results.md) has the details. Ideas and questions go to
[Discussions](../../discussions), bugs and proposals to [issues](../../issues).

## Quick start

Requirements: Linux x86_64 or arm64 with Docker (rootful, cgroup v2), at least 4 physical CPU cores for
publishable results, Python 3.11 or newer. Node.js 22.23.4 or newer only to view the website locally. The
engine uses only the Python standard library; the load generators and measurement tools run in a runner
container that `./benchmania check` and `./benchmania run` build from `core/runner/`, and every implementation
is built as its own Docker image.

```sh
git clone https://github.com/benchmania/benchmania && cd benchmania
./benchmania doctor                                            # checks Docker, cgroup v2 and the CPU layout
./benchmania list                                              # domains, scenarios, implementations
./benchmania check backend --impl go-nethttp rust-axum         # build two implementations, run the functional checks
./benchmania run backend --impl go-nethttp rust-axum --quick --passes 1
```

The quick run writes a result bundle to `results/backend/`. Quick runs are smoke tests: they are marked as
such and never published (`publish` skips them), so do not commit that file. For real numbers, run the whole suite
(all 15 implementations, 5 passes; several hours, and the first build of the GraalVM native image alone takes
a while), then build the website dataset and look at it:

```sh
./benchmania run backend
./benchmania publish                                           # result bundles -> site/src/data
cd site && npm ci && npm run dev
```

Two runs are published so far, both measured by the maintainers on the same 6-core machine: a reference run
with the current methodology (5 passes) and a preliminary one from the pre-release suite (methodology 0,
3 passes), which is kept for transparency and labelled as preliminary.

## How it works

```
benchmania.toml          project identity and run defaults (rename the project here)
core/benchcore/         engine: manifests, runner, CPU layout, collectors, load generators, statistics, bundles
core/runner/            runner image: Alpine at a fixed release with its packages (python3, wrk, docker-cli)
                        and oha at a fixed version, verified by checksum
domains/<id>/           one directory per domain: domain.toml, metrics.toml, harness.py, scenarios/, implementations/
results/<domain>/<machine>/<run>.json   result bundles (data license CC BY 4.0)
site/                   website, built from the dataset that `publish` generates
docs/                   methodology, architecture, contributor guides, decision records
```

`./benchmania run` starts a privileged runner container with access to the Docker socket and the host's
cgroups. The runner pins itself to the load-generator CPUs, starts the domain's environment (for the backend:
PostgreSQL), builds and checks every implementation, then measures them in several passes, in a different
order each pass. Every measurement window records throughput and latency from the load generator plus CPU time from
the container's cgroup, proportional memory (PSS), the database work per request, hypervisor steal time,
CPU clock and package energy where available. Results are written as self-describing JSON bundles that CI
re-verifies from the per-pass data.

Read more: [methodology](docs/methodology.md) · [architecture](docs/architecture.md) ·
[maintaining the project](docs/maintaining.md)

## Contributing

- [Run on your hardware and submit results](docs/guides/submitting-results.md) — a pull request with one bundle file
- [Add an implementation](docs/guides/adding-an-implementation.md) — a directory with `impl.toml`, a Dockerfile and your code
- [Add a scenario](docs/guides/adding-a-scenario.md) — one TOML file
- [Add a domain](docs/guides/adding-a-domain.md) — start from `domains/_example`
- [Report a methodological problem](../../issues/new?template=methodology.yml) — fairness reports are very welcome

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and review rules.

## Renaming the project

The name lives in `benchmania.toml`. Code and the website read it from there. To rename everything, including
documentation and the CLI wrapper: `python3 tools/rename_project.py "NewName"`.

## License

Code: [MIT](LICENSE). Result data in `results/`: [CC BY 4.0](results/LICENSE).
