# Methodology

This document describes how results are produced and how to read them. It applies to methodology
version **1** of the backend domain. Bundles carry their methodology version; the website labels older ones.

## Goals

1. **Production-shaped conditions.** Services run under the resource limits of a small production pod,
   against a real database, with realistic request mixes, not only at saturation.
2. **Same work for everyone.** Every implementation passes the same functional checks, and the work it
   does per request is measured, not assumed.
3. **Transparent and reproducible.** Every number comes with the machine, the exact versions, the
   configuration and the per-pass raw values.
4. **Honest uncertainty.** Medians with confidence intervals, quality flags instead of silent filtering.

## Environment (backend)

| Role | Resources | Notes |
|---|---|---|
| Service | 2 logical CPUs (one per physical core), 1 GiB memory, CPU quota 2.0 | SMT siblings of these cores stay idle |
| PostgreSQL 18 | half of the remaining cores | `synchronous_commit=off`, `shared_buffers=256MB`, `pg_stat_statements` |
| Load generator + runner | the other half | wrk (closed loop) and oha (open loop, latency corrected) |

All containers share one network namespace and talk over loopback, so no NAT or bridge sits in the path and
no host port is used. The CPU layout is computed from the machine's topology and stored in every result.

The database holds 10,000 rows with deterministic content. Before each implementation in each pass the
harness restores that content, runs `VACUUM ANALYZE` and `CHECKPOINT` and resets `pg_stat_statements`, so
every implementation starts from the same database state. It does the same after every workload that
writes (`updates`, its warm-up and `soak`), so the scenarios that follow never read rows, dead tuples or
autovacuum activity left behind by the updates, however many of them an implementation managed to do.

Every implementation uses 16 database connections in total and prepared statements, waits for a free
connection instead of failing, and sends one statement per round trip (no batching, no pipelining or
multiplexing options). Whether a request keeps one pooled connection for all its statements or checks one
out per statement follows what is idiomatic for the stack and is stated in its notes.

## Scenarios

| Scenario | Load | What it shows |
|---|---|---|
| `startup` | container start → first `GET /json` = 200, 5 times; idle memory 5 s later | cold start, base footprint |
| `cold` | `GET /db`, 128 connections, 10 s, right after start, no warm-up | warm-up penalty after scaling out |
| `json` | `GET /json`, 128 connections | framework overhead without I/O |
| `db` | `GET /db` (1 SELECT) | single query path |
| `queries` | `GET /queries` (20 sequential SELECTs) | driver and async efficiency |
| `updates` | `GET /updates` (5 SELECT + 5 UPDATE) | write path |
| `list` | `GET /list` (100-row range, computed field, serialization) | typical REST list endpoint |
| `orders` | `POST /orders` (2.5 KB JSON, 50 items, validation, totals) | request parsing and validation |
| `db-c16`, `db-c512` | `GET /db` with 16 and 512 connections | low concurrency and many keep-alive connections |
| `rate` | `GET /db` at a fixed 5,000 req/s for 20 s | latency at normal load (all services, same load) |
| `soak` (optional) | `GET /updates` at 2,000 req/s for 5 minutes | p99 drift, memory growth |

Per implementation and pass: the five cold starts, idle memory, the cold scenario, a global warm-up of 4 s per
endpoint, then for each closed-loop scenario 5 s of warm-up and 15 s of measurement.

## Metrics

Collected for every measured window (see `domains/backend/metrics.toml` for the complete registry):

- **Load generator:** requests, throughput, errors (socket errors, timeouts, non-2xx/3xx), latency
  mean, standard deviation, p50, p75, p90, p99, p99.9, p99.99, maximum, bytes per response.
  **Throughput counts successful (2xx/3xx) responses only**, so answering errors quickly is not rewarded.
- **Service cgroup:** CPU time per request (exact, from `cpu.stat`), cores used, user/kernel split, CPU
  throttling, disk writes, and the highest anonymous memory seen (sampled every second, like PSS).
- **Service processes:** peak proportional set size (PSS), sampled every second — shared pages are counted
  once, so multi-process servers are not over-counted.
- **Database:** PostgreSQL CPU time per request, SELECT and UPDATE statements per request
  (`pg_stat_statements`).
- **Machine:** hypervisor steal time, 1-minute load, CPU clock of the service cores, CPU package energy
  (RAPL) where readable, load-generator CPU utilization.

Derived per run: **throughput index** (geometric mean of throughput over the six workload scenarios,
relative to the best implementation = 100), **CPU efficiency index** (the same for CPU per request) and
**peak memory** (highest PSS in any scenario).

An implementation gets an index only if it has a usable result in **all six** workloads. A missing scenario,
a throughput of zero or more than 1 % failed requests in one of them withholds the index; the individual
scenario results stay visible with their flags. Only implementations that get an index are compared with
each other, so a broken implementation can neither earn a good index nor distort the others'.

## Repetition and statistics

- A run has **5 passes** by default. The order of implementations changes every pass: it follows the
  first row of a Williams design, shifted per pass, so that each implementation runs at a different
  position and after a different implementation in every pass (with an odd number of implementations one
  neighbour can repeat once). What one implementation leaves behind (heat, caches) therefore does not
  always hit the same successor.
- Each metric is summarized over passes by its **median**, the **interquartile range**, a **95 % percentile
  bootstrap interval of the median** (2,000 resamples, fixed seed for reproducible summaries) and the
  coefficient of variation. With five passes the interval is exactly the range between the lowest and
  the highest pass, which covers the true median with 93.75 % probability whatever the distribution; that
  is the honest answer for so few repetitions. Below five passes no interval is reported at all, because
  the same range would cover only 87.5 % (four passes) or 75 % (three), and calling that a 95 % interval
  would overstate what is known. The lowest and highest pass are always part of the result.
- A pass in which the measurement of an implementation fails is recorded with its error and flagged; the
  number of passes behind every value (`n`) is part of the result.
- Outliers are **flagged, not removed**: a pass whose value has a robust z-score above 3.5 (median absolute
  deviation) is marked in the summary.
- Throughput varying more than 10 % between passes is flagged.

## Quality controls

| Check | Effect |
|---|---|
| Functional checks (`domains/backend/checks.py`): shapes and types, values equal to what the database holds, JSON content type on every endpoint, persisted updates, consecutive list ranges, order totals rounded to cents, rejected invalid orders (empty, quantity below 1, negative price, empty SKU), no errors in a short burst | implementation is excluded from the run |
| Database statements per request deviate more than 3 % from the scenario specification | result flagged |
| Errors during a measurement | result flagged with count and rate |
| Load generator CPU above 90 % | throughput flagged as a lower bound |
| Database CPU above 90 % of its cores | flagged: the database limits the throughput, not only the service |
| Hypervisor steal above 2 % | measurement repeated up to 2 times, then flagged |
| Fixed-rate scenario (`rate`, and every slice of `soak`) reaches less than 97 % of the target rate | flagged: latency then describes queueing, not the service |
| More than 1 % failed requests in a workload scenario | no throughput or efficiency index for that implementation |
| Measurement of an implementation fails in a pass | flagged as an error, values of that pass missing from `n` |
| Bundle summary (any statistic) does not match its per-pass data, or the bundle is stored under the wrong domain, machine or run id | rejected by CI |

The website dataset is always recomputed from the per-pass values; the summary stored in a bundle is only
checked, never trusted. Manipulated per-pass values cannot be detected this way, which is what the
provenance label is for: a run is **reference** only if maintainers measured it themselves and listed its
run id in `results/reference-runs.toml` (a file only maintainers can change); every other run is
**community**. A machine id alone never makes a run a reference run, because every machine of the same
model has the same id.

A run that is interrupted (Ctrl-C or `docker stop`) writes a bundle with status `partial` and removes its
containers. Quick runs (`--quick`) and checkpoints of runs that died without finishing are never published,
and a run limited to some implementations or scenarios never becomes the default view.

## Comparing machines

Absolute throughput depends heavily on the CPU, so the primary comparison is always **within one run**.
For comparisons across machines use the relative indices and CPU time per request, which depend much less
on the machine. Every bundle stores the machine fingerprint (CPU model, cores, SMT, governor, turbo,
memory, kernel, OS, virtualization, Docker version) and the CPU layout, so differences can be explained.
Measurements on shared cloud VMs are far noisier than on dedicated hardware; the steal-time check catches
the worst cases.

## Known limitations

- Start-up time includes `docker start`. The overhead is identical for every implementation but means the
  numbers are not process start times.
- Package energy covers the whole CPU package, including the database and the load generator.
- PSS and anonymous memory are sampled once per second; spikes shorter than that can be missed.
- Throughput and latency of the fixed-rate scenario come from a different load generator (oha) than the
  closed-loop scenarios (wrk). `bytes_per_resp` includes headers for wrk and only the body for oha.
- The load generator shares the machine. Its CPU use is measured and flagged when it could limit throughput.
- The database shares the machine, too. In `queries` (20 statements per request) and `updates` (10) most of
  the work is done by PostgreSQL, and on a machine with few cores the fastest implementations saturate it:
  their throughput then ends up close together and says more about the database than about the service.
  CPU time per request still separates them. On the 6-core reference machine this is the case for the
  fastest implementations in both scenarios. Runs made after the first reference run record the database's
  CPU use (`db_cpu_util`) and flag it; in earlier bundles it can be computed as database CPU per request
  times requests per second.
- Implementations are written to be idiomatic, but configuration choices (pool sizes, worker counts, heap
  size) matter. They are documented in each `impl.toml`; better configurations are welcome as pull requests.
- Drivers differ in details the rules allow: Go (pgxpool) and Spring (JdbcClient) check a connection out per
  statement, the others once per request. Bun's SQL client may pipeline queries of concurrent requests on
  one connection by default; this has not been verified by a packet capture.
- The JVM variants run with a heap limit of 50 % of the container memory, so their reported memory is
  bounded by that setting rather than by what the workload needs.
- Builds are pinned as far as each ecosystem allows: exact base image tags (digests for distroless),
  exact dependency versions and lockfiles. Not pinned: operating-system packages installed during image
  builds, transitive NuGet packages (no lock file), and patch releases behind a few upstream image tags
  (for example the OTP patch level of the Elixir image). Every bundle records the image id that was measured.
- The GraalVM native image is built with JDK 25, the JVM variants run on JDK 27.
- Image size is what the local Docker image store reports. Docker versions differ in whether that is the
  unpacked or the compressed size (the same image showed 284 MB on one machine and 84 MB on another), so it
  is comparable within a run but not across machines.

## Methodology versions

| Version | Changes |
|---|---|
| 0 | Pre-release shell suite: throughput, p50/p99, errors, start-up, memory; floating image tags; peak memory recorded once per run; 3 s warm-up + 12 s measurement. |
| 1 | Engine release: pinned versions and image ids, CPU per request, database work verification, PSS per scenario, steal-time retries, energy, CPU clock, stricter functional checks, database content restored before every implementation and after every writing workload, throughput counts successful responses only, order of implementations varied by a Williams design, prepared statements in every stack (the .NET variants of version 0 ran without), 5 s + 15 s windows. |
