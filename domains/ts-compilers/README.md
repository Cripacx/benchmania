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

Where the revisions come from: the `typescript@7.1.0-beta` package names `3e923636` as its `gitHead`, and the
`tsrs` package names the same commit as `typescriptCommit`. The `tsc-rs` package states only that it ports
`7.1.0-dev`; the nightly and commit in the table come from `UPSTREAM.md` of its repository ("tsc-rs 0.4.0 to
0.8.0 used the pin `fed0bf24149f`", the `gitHead` of `typescript@7.1.0-dev.20261008.1`; read at
`pingdotgg/ts-rust@91f3d02`). These are the revisions the packages and repositories declare: the benchmark
checks that the tools report the same diagnostics on the workloads, not which revision they implement.

**Read the comparisons by TypeScript line.** The tools implement different compiler revisions, and a newer
revision can be faster or slower for reasons that have nothing to do with the language it is written in.
tsc 7.1 is included although it is a beta because it is the packaged Go build of the revision that tsrs
targets: **tsc 7.1 (beta) against tsrs is the like-for-like comparison** of a Go and a Rust implementation of
the same upstream revision. tsc-rs 0.8.0 tracks an earlier 7.1 development build, so against tsc 7.1 and tsrs
it mixes revision and implementation. tsc 7.0 and tsc 7.1 are both written in Go: between them, two releases
of the same Go compiler are compared, not two languages. tsc 6.0 against 7.0 compares a JavaScript and a Go
compiler of different releases. The check index on the website spans all of them.

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
| `typeorm-check`, `excalidraw-check` | a type check of the project (`-p`, not incremental) without output (`--noEmit`), default settings | 4 |
| `typeorm-check-1cpu`, `excalidraw-check-1cpu` | the same check with the tool's single-threaded flag (`--singleThreaded`); tsc 6 has none and runs unchanged | 1 |
| `typeorm-emit` | the check plus JavaScript and declaration output (`--outDir`, `--declaration`) | 4 |

tsc 6 checks on one thread, but Node.js runs work such as garbage collection on helper threads, so it uses
more than one core on four and is slower on one, although it runs the same command in both. It rejects
`--singleThreaded` (TS5023) and `--checkers` (TS5025).

Every tool runs through the command its npm package installs (`tsc`, `tsrs`, `tsc-rs`), as a user would run
it: for tsc 7, tsrs and tsc-rs that is a launcher that starts the native binary, and the launcher is part of
the measurement. With tsc 7 and tsrs every run starts Node.js first, which then replaces itself with the
binary (`process.execve`, which the Node.js of the image has; the launchers fall back to a child process
without it); tsc-rs has a shell script that `exec`s the binary. In all four the compiler ends up as the same
process the timer started, and no process of the command is left when it returns (the timer checks every run,
see below). The Node.js version of all images is `[defaults] node` in `domain.toml`; `check` verifies that
the image has it, and every result records it. The exact command of every mode is in the `[compiler]` table
of each `impl.toml` and is published with every result, and so is the command line of every measured scenario
(in the quality data). Common flags: `-p <tsconfig> --incremental false --composite false --pretty false`.

**How a scenario is measured.** Every scenario of every pass gets a fresh container: no network
(`--network none`; the functional check verifies that such a container has nothing but loopback), pinned to the
service CPUs with `--cpuset-cpus` (four, or the first one of them; no CPU quota on top, which could not lower
the limit and could only throttle a busy tool), 8 GiB of memory, and a fresh writable copy of the workloads.
Node.js sizes its default heap from that limit, so the limit is part of the setup for tsc 6. Inside the
container a small timer (`images/tool/timer.py`) runs the command: one untimed warm-up run (page cache, and the
Node.js compile cache that tsc 6 writes on its first run), then five timed runs (`--quick`: no warm-up and one
timed run). It starts the clock right before it spawns the command and stops it when `wait4` returns, so
`docker exec` is not part of any time.

Every run, warm-up included, is verified: the diagnostics must be exactly the expected ones; the exit code
must be exactly 0 when none are expected and exactly the tool's `error_exit` otherwise; no process that was
not there before the command started may be left in the container when it returns (still running, or exited
and never reaped: PID 1 of the container reaps nobody, so a zombie stays visible); and the emit scenario must
write the expected number of `.js` and `.d.ts` files (into an in-memory file system, emptied before every run
outside the timed window). A run that fails verification is not a measurement: the scenario stays unmeasured
in that pass, with the reason in its quality flags, and the other scenarios still run. If the hypervisor took
more than the configured steal time during a scenario, the scenario is repeated in a new container, but only
after the runs of the first attempt were verified: a failure is never hidden by the repetition.

**Metrics** (median of the timed runs of a pass; every run's value is kept in the quality data):

- `wall_ms`: wall time of the command, launcher included.
- `cpu_ms`: user plus system time of the command and every process it started and waited for, all threads.
- `peak_rss_mib`: the median over the timed runs of the largest resident set of any single process of the
  command (`ru_maxrss` from `wait4`, which covers the command and the descendants it waited for). It is a
  maximum over processes, not a sum. Since the launchers replace themselves with the compiler, that process
  is the compiler, and its maximum also covers the launcher phase before the `execve`: with the Node.js
  launcher of tsc 7 and tsrs that is about 50 MiB, against about 12 MiB for the binary run directly
  (measured with `--version`), so no value of theirs is below that. It counts the
  resident pages of that process (its binary included), not the page cache of the files it read. The
  container's cgroup `memory.peak` is not used: it counts page cache, which the kernel charges to whichever
  container read a file first, so it would depend on the order in which tools run.
- `parallelism` (diagnostic): CPU time divided by wall time.
- `steal_pct`, `host_load`, `cpu_mhz` (diagnostic, from the engine): hypervisor steal, load average and CPU
  clock around the scenario's runs (warm-up included).
- Derived: `check_index`: a tool only gets it with a valid measurement in all four check scenarios. For each
  of them, the fastest median wall time among those tools divided by this tool's; the geometric mean of the
  four ratios, times 100 (100 = fastest in all four, 50 = twice the fastest time on geometric average).
  `peak_rss_max_mib`: the highest `peak_rss_mib` of a tool in any scenario.

### Does `--singleThreaded` take effect?

CPU time divided by wall time on the unchanged workloads with four CPUs available, in the default mode and with
the single-threaded flag (three runs each, one Boat sandbox with an AMD EPYC 4585PX, observed while this gate
was built; not part of any gate rule):

| Tool | TypeORM, default | TypeORM, single-threaded | Excalidraw, default | Excalidraw, single-threaded |
|---|---|---|---|---|
| tsc 6.0 (no flag: same command) | 1.76–1.80 | 1.74–1.83 | 1.66–1.72 | 1.68–1.72 |
| tsc 7.0 | 3.46–3.55 | 1.32–1.37 | 3.42–3.45 | 1.20–1.32 |
| tsc 7.1 (beta) | 3.43–3.53 | 1.25–1.29 | 3.81–3.87 | 1.25–1.36 |
| tsrs | 2.82–2.90 | 1.02 | 3.27–3.51 | 1.00 |
| tsc-rs | 3.04–3.31 | 1.01 | 3.43–3.50 | 1.00 |

The flag takes effect in all four tools that have it. The Rust ports then use one core; tsc 7 still uses 0.2 to 0.4
cores more, presumably the Go runtime (garbage collection; not investigated), so on one CPU it competes with
its own helper threads, as tsc 6 does with those of Node.js.

## The correctness gate

`check` runs before anything is measured. A tool is measured only if every scenario passes two steps:

1. Run once on the unchanged workload, it reports exactly the diagnostics the workload expects for the tool's
   TypeScript line (`[expected]` in `workloads/<id>/workload.toml`, keyed by line: `"7.1" = []`), with exit
   code 0 if none are expected.
2. Run again in a container where every seeded error of the workload (`[[seeded_errors]]`, seven for TypeORM,
   eight for Excalidraw) was appended to the end of its file, it reports exactly the expected diagnostics plus
   every seed's diagnostics for its line, at the same file, line, column and error code, and exits with
   exactly its `error_exit` for that mode. The edits are thrown away with the container.

The same rules as for a measured run apply to both (exit code, no process left behind, number of emitted
files in the first step).

Each seed is in a file of its own, and the files are spread over the projects: TypeORM `src/driver`,
`src/repository`, `src/metadata`, `src/find-options`, `src/migration`, `src/naming-strategy` and `test/utils`;
Excalidraw `packages/math`, `packages/element`, `packages/common`, `packages/utils`,
`packages/excalidraw/scene`, `packages/excalidraw/data`, `packages/excalidraw/components` and
`excalidraw-app/components`. Each one is a different checker feature, and each depends on a type declared in
another file (most of Excalidraw's across a package boundary, through the `paths` mapping): a wrong argument to
a project function, a property that does not exist on a project class, a mistyped or missing property in an
object literal typed by a project interface, a violated generic constraint, a possibly-undefined access under
strict null checks, a class that does not implement a project interface, assignability to a union from an
indexed access type, and in two `.tsx` files a JSX prop of the wrong type and missing required JSX props. The
`intent` of each seed in `workload.toml` names the feature. All of them are appended with unique exported
names, so nothing else in the file changes and no line above them moves. Expectations are per TypeScript line:
the TypeORM seed in `test/utils` is TS2345 for 6.0 and TS2741 for 7.0 and 7.1, at the same position.

Every mode (default, single-threaded, emit) goes through both steps. A flag or mode that made a tool check
less (skip files, skip the checker, stop early) passes the first step and is caught in the second when it
changes one of the expected outcomes: a seed that is not reported, another code or position, another exit
code. A tool that checked less but still checked the fifteen seeded files and what they depend on would
pass, and so would one that ignored its single-threaded flag (see the observations above).

**What passing is evidence of.** On these two projects, in every mode, the tool reports no diagnostic that its
TypeScript line does not expect, and it finds fifteen errors that it can only find by resolving imports and
checking types across files, in source and test files, across package boundaries and in TSX. It exits with
its documented code, did not crash after printing them, and leaves no process behind. As the expectations
stand, the four 7.x tools report the same diagnostics as each other on both workloads with and without the
seeds, and tsc 6.0 the same as them except for the one code that differs by line.

**What it cannot show.** That a tool checks code that is not in the workloads correctly, or reports the same
diagnostics as the others on it. That it checked every file of the project: the seeds cover fifteen files, and
a tool that skipped other files without errors in them would still pass (the emit scenario's file count covers
TypeORM's emitted files, not the checker). That a type the seeds do not touch was inferred correctly. That
the emitted JavaScript and declarations are correct: only their number is checked.

Diagnostics are compared by file, line, column, category and code, not by message text. Both workloads expect
no diagnostics today, but the lists are per line on purpose: minor versions of TypeScript change diagnostics,
so a new line must state its own.

The exit code a tool returns when it reports errors is `error_exit` in `[compiler]` of its `impl.toml`: one
code, or one per mode. tsc 6.0, tsc 7.1 (beta), tsrs and tsc-rs exit 2 in every mode; tsc 7.0.2 exits 1 when it
writes no output (`--noEmit`, the check modes) and 2 in the emit scenario, which is TypeScript's own
convention (1: errors, outputs skipped; 2: errors, outputs generated). Anything else, including a crash after
the expected diagnostics were printed, is never valid.

## Adding things

- **A patch version** of an existing tool: change its version in `[versions]` of its `impl.toml`. The image
  installs exactly that version (the harness passes the `[versions]` entry of `[compiler] package` to the
  shared Dockerfile `images/tool/Dockerfile`). Run `check`: a new version may change an exit code or a
  diagnostic.
- **A release line** (tsc 7.2) or **a tool**: a new `implementations/<id>/impl.toml` (copy one; ids are
  lowercase letters, digits and dashes, so `tsc-7-2`) with `[versions]`, `[compiler]` (package, TypeScript
  line, command, the `check`, `single` and `emit` arguments, environment, `error_exit` as observed) and the
  same `[build]`. Then add the expected diagnostics of the new line to every workload, both `[expected]` and
  the `expect` of every seed; `validate` fails until each has them. A tool that is not on npm needs its own
  Dockerfile that starts `FROM` the `WORKLOADS` build argument.
- **A workload**: a directory `workloads/<id>/` with `workload.toml` (repository, full commit, project
  directory, tsconfig, expected diagnostics per line, `[[seeded_errors]]`) and `prepare.sh`, which runs in the
  checkout at image build time and installs the dependencies from the lockfile without scripts. Then scenario
  files that name it (an emit scenario must have `expect_files`), and the scenario ids in `[[derived]]` of
  `domain.toml` if the index should cover them. The harness builds one image stage per workload, so a new one
  does not invalidate the others. Each seed has an `intent`, a `file` of its own, an `append` that starts with
  a newline and an `expect` per TypeScript line with at least one diagnostic in that file. Write the seeds
  first, then take the positions from what the tools report, and confirm that every tool of a line reports
  the same diagnostics in every mode. A seed whose result the tools disagree on is not adjusted until they
  agree: the disagreement is the finding.

## Limits

- The Node.js base image is referenced by tag (`node:<version>-trixie-slim`), its Debian packages (git,
  Python) are installed from the live package repositories, and the compiler's own npm package is installed at
  an exact version, but its transitive npm packages (the native binary packages of tsc 7, tsrs and tsc-rs)
  are not locked. Every result bundle records the id of the image that was measured.
- Emitted output is verified by the number of `.js` and `.d.ts` files only, not by content, and not compared
  between tools.
- The index is computed from the per-scenario medians of one run and is relative to the tools that have an
  index in that run: adding or removing a tool can change the reference of every other tool's index. A
  measurement that carries a quality flag (for example steal above the limit after the last retry) still
  counts in the medians; the flag is published next to it.
- The single-threaded ratios and the launcher memory figures above are observations from one machine and
  the image that was tested, and they are not checked by the gate. That tsc 7's extra CPU time in
  single-threaded mode comes from the Go runtime is an inference.
- The check for leftover processes compares the process ids visible in the container before the command and
  after `wait4` returned. It does not follow ancestry: a second `docker exec` into the container during a run
  would be reported (the harness starts none), and a leftover process that got the id of a process that had
  exited in the meantime would be missed.

## Not compared, and deferred

- **`--fast`** of tsrs and tsc-rs: it changes what the checker does, and only the ports have it.
- **Incremental checks** (`--incremental`, `tsc -b`, watch mode): a re-check after an edit is as slow as a
  full check for some tools and depends on which file changes; it needs its own design.
- **A large workload** (Sentry): tsc 6 needs a heap of about 12 GB for it, and tsc 7.0 and 7.1 disagree on
  its diagnostics, so it needs a per-line expectation and a bigger machine.
- Language servers, bundlers and transpile-only tools (esbuild, swc) are out of scope: they do not type-check.
