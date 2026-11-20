# TypeScript compilers

The same TypeScript projects, type-checked and compiled by five tools.

The domain is not on the website yet (`status = "example"` in `domain.toml`): the website's dataset tests
reject a published domain without results. It becomes `experimental` with its first result bundle.

| Implementation | npm package | Written in | TypeScript line | Status |
|---|---|---|---|---|
| `tsc-6-0` | `typescript@6.0.3` | TypeScript (runs on Node.js) | 6.0 | stable |
| `tsc-7-0` | `typescript@7.0.2` | Go | 7.0 | stable |
| `tsc-7-1` | `typescript@7.1.0-beta` | Go | 7.1 | pre-release |
| `tsrs` | `tsrs@7.1.0-beta.tsrs3` | Rust | 7.1, the revision of 7.1.0-beta (`microsoft/TypeScript@3e923636`) | experimental port |
| `tsc-rs` | `tsc-rs@0.8.0` | Rust | 7.1, the revision of 7.1.0-dev.20261008.1 (`microsoft/TypeScript@fed0bf24`) | experimental port |

**Read the comparisons by TypeScript line.** The tools implement different compiler revisions, and a newer
revision can be faster or slower for reasons that have nothing to do with the language it is written in.
tsc 7.1 is included although it is a beta because it is the only Go build of the revision that tsrs ports:
**tsc 7.1 (beta) against tsrs is the like-for-like comparison** of a Go and a Rust implementation of the same
compiler. tsc-rs 0.8.0 tracks an earlier 7.1 development build, so against tsc 7.1 it is close but not
identical. tsc 6.0 against 7.0 compares a JavaScript and a Go compiler of different releases; tsc 7.0 against
the ports mixes revision and implementation. The check index on the website spans all of them.

## What is measured

Two open-source projects, fetched at pinned commits when the image is built, with their dependencies
installed from their lockfiles without install scripts:

| Workload | Repository and commit | Compiled project | Change to the project |
|---|---|---|---|
| `typeorm` | `typeorm/typeorm` `d5b143dd` | `packages/typeorm`, `tsconfig.bench.json` | `module` and `moduleResolution` set to `nodenext` (the repository's `node10` is deprecated in TypeScript 6 and removed in 7) |
| `excalidraw` | `excalidraw/excalidraw` `53973c3a` | repository root, `tsconfig.bench.json` | the `"baseUrl"` line of `tsconfig.json` removed (deprecated in TypeScript 6, TS5101; removed in 7, TS5102) |

All five tools report no errors on both with these changes. Nothing of the projects is committed here.

Five scenarios:

| Scenario | What runs | CPUs |
|---|---|---|
| `typeorm-check`, `excalidraw-check` | a full type check without output (`--noEmit`), default settings | 4 |
| `typeorm-check-1cpu`, `excalidraw-check-1cpu` | the same check with the tool's single-threaded flag (`--singleThreaded`); tsc 6 has none and runs unchanged | 1 |
| `typeorm-emit` | the check plus JavaScript and declaration output (`--outDir`, `--declaration`) | 4 |

tsc 6 checks on one thread, but Node.js runs work such as garbage collection on helper threads, so
it uses more than one core on four and is slower on one, although it runs the same command in both.

Every tool runs through the command its npm package installs (`tsc`, `tsrs`, `tsc-rs`), as a user would run
it: for tsc 7, tsrs and tsc-rs that is a launcher (Node.js, or a shell script for tsc-rs) that starts the
native binary, and the launcher is part of the measurement: with tsc 7 and tsrs every run starts a Node.js
process first. The Node.js version of all images is `[defaults] node` in `domain.toml`; `check` verifies that
the image has it, and every result records it. The exact command of every mode is in the
`[compiler]` table of each `impl.toml` and is published with every result, and so is the command line of
every measured scenario (in the quality data). Common flags: `-p <tsconfig> --incremental false --composite
false --pretty false`.

**How a scenario is measured.** Every scenario of every pass gets a fresh container: no network
(`--network none`; the functional check verifies that such a container has nothing but loopback), pinned to the
service CPUs with `--cpuset-cpus` (four, or the first one of them; no CPU quota on top, which could not lower
the limit and could only throttle a busy tool), 8 GiB of memory, and a fresh writable copy of the workloads. Node.js sizes its default heap from that limit, so the limit is part of the
setup for tsc 6. Inside the container a small timer (`images/tool/timer.py`) runs the command: one untimed
warm-up run (page cache, and the Node.js compile cache that tsc 6 writes on its first run), then five timed
runs (`--quick`: no warm-up and one timed run). It starts the clock right before it spawns the command and
stops it when `wait4` returns, so `docker exec` is not part of any time. Every run is verified: the
diagnostics must be exactly the expected ones, the exit code must agree with them, and the emit scenario must
write the expected number of `.js` and `.d.ts` files (into an in-memory file system, emptied before every run outside the timed
window). A run that fails verification is not a measurement: the scenario stays unmeasured in that pass, with
the reason in its quality flags, and the other scenarios still run. If the hypervisor took more than the
configured steal time during a scenario, the scenario is repeated in a new container.

**Metrics** (median of the timed runs of a pass; every run's value is kept in the quality data):

- `wall_ms`: wall time of the command, launcher included.
- `cpu_ms`: user plus system time of the command and every process it started and waited for, all threads.
- `peak_rss_mib`: the largest peak resident set size of any single process of the command (`ru_maxrss`),
  which is the compiler itself. Not a sum over processes; it counts the resident pages of that process (its
  binary included), not the page cache of the files it read. The container's cgroup
  `memory.peak` is not used: it counts page cache, which the kernel charges to whichever container read a
  file first, so it would depend on the order in which tools run.
- `parallelism` (diagnostic): CPU time divided by wall time.
- `steal_pct`, `host_load`, `cpu_mhz` (diagnostic, from the engine): hypervisor steal, load average and CPU
  clock around the scenario's runs (warm-up included).
- Derived: `check_index`, the geometric mean over the four check scenarios of each tool's wall time relative
  to the fastest one (a tool only gets it with a valid measurement in all four), and `peak_rss_max_mib`.

## The correctness gate

`check` runs before anything is measured. A tool is measured only if:

1. every scenario, run once, reports exactly the diagnostics its workload expects for the tool's TypeScript
   line (`[expected]` in `workloads/<id>/workload.toml`, keyed by line: `"7.1" = []`); and
2. the same scenario, run again after an error was appended to one file of the workload (`[seeded_error]`;
   the edit is thrown away with the container), reports exactly the expected diagnostics plus that error, at
   the same file, line, column and error code.

Every scenario goes through both steps, so each mode (default, single-threaded, emit) has to find the seeded
error: a flag that made a tool check less would pass the first step and fail the second.

The gate shows that a tool reports the expected diagnostics on these two projects and finds one seeded error
in every mode. It cannot show that a tool agrees with the others on code that is not in the workloads.

Diagnostics are compared by file, line, column, category and code, not by message text and not by exit code
(tsc 7.0.2 exits 1 where the others exit 2 for the same error). The exit code still has to agree: 0 when no
diagnostics are expected, non-zero otherwise; a crash or an out-of-memory exit is never valid. Both workloads
expect no diagnostics today, but the lists are per line on purpose: minor versions of TypeScript change
diagnostics, so a new line must state its own.

## Adding things

- **A patch version** of an existing tool: change its version in `[versions]` of its `impl.toml`. The image
  installs exactly that version (the harness passes the `[versions]` entry of `[compiler] package` to the
  shared Dockerfile `images/tool/Dockerfile`).
- **A release line** (tsc 7.2) or **a tool**: a new `implementations/<id>/impl.toml` (copy one; ids are
  lowercase letters, digits and dashes, so `tsc-7-2`) with `[versions]`, `[compiler]` (package, TypeScript
  line, command, the `check`, `single` and `emit` arguments, environment) and the same `[build]`. Then add the
  expected diagnostics of the new line to every workload; `validate` fails until each workload has them.
  A tool that is not on npm needs its own Dockerfile that starts `FROM` the `WORKLOADS` build argument.
- **A workload**: a directory `workloads/<id>/` with `workload.toml` (repository, full commit, project
  directory, tsconfig, expected diagnostics per line, seeded error) and `prepare.sh`, which runs in the
  checkout at image build time and installs the dependencies from the lockfile without scripts. Then scenario
  files that name it, and the scenario ids in `[[derived]]` of `domain.toml` if the index should cover them.
  The harness builds one image stage per workload, so a new one does not invalidate the others. Determine the
  seeded error's position by running it, and confirm that every tool reports the same diagnostics.

## Not compared, and deferred

- **`--fast`** of tsrs and tsc-rs: it changes what the checker does, and only the ports have it.
- **Incremental checks** (`--incremental`, `tsc -b`, watch mode): a re-check after an edit is as slow as a
  full check for some tools and depends on which file changes; it needs its own design.
- **A large workload** (Sentry): tsc 6 needs a heap of about 12 GB for it, and tsc 7.0 and 7.1 disagree on
  its diagnostics, so it needs a per-line expectation and a bigger machine.
- **Emitted output** is verified by number of files, not compared byte for byte between tools.
- Language servers, bundlers and transpile-only tools (esbuild, swc) are out of scope: they do not type-check.
