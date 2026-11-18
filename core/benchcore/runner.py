"""Run orchestration.

`launch` runs on the host: it builds the runner image and starts the runner container, which has the
host PID and cgroup namespaces and the Docker socket. Inside, `execute` does the actual work: CPU layout,
machine fingerprint, environment, builds, functional checks, rotated passes and the result bundle.
Every container of a run joins the runner's network namespace, so no host port is ever used.
"""

import datetime as dt
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import __version__, bundle, layout, machine, manifest
from .docker import Docker
from .harness import Context

INSIDE_ENV = "BENCHCORE_INSIDE"
STOP_GRACE_S = 90  # time the runner gets to write a partial bundle and remove its containers


def log(msg):
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def runner_name(project):
    return project.container("runner")


def launch(project, argv):
    """Host side: start the privileged runner container and forward the command line to it."""
    docker = Docker(project.label, log)
    if not docker.available():
        sys.exit("Docker is not reachable. Start Docker (Linux with cgroup v2 gives the most accurate results).")
    image = f"{project.container('runner')}:{__version__}"
    log(f"building runner image {image}")
    docker.build(image, project.root / "core" / "runner", project.root / "core" / "runner" / "Dockerfile")
    docker.remove(runner_name(project))
    cmd = ["docker", "run", "--rm", "--name", runner_name(project), "--label", f"{project.label}=true",
           "--privileged", "--pid", "host", "--cgroupns", "host",
           "-v", "/var/run/docker.sock:/var/run/docker.sock",
           "-v", "/sys/fs/cgroup:/sys/fs/cgroup:ro",
           "-v", f"{project.root}:/work", "-w", "/work",
           "-e", f"{INSIDE_ENV}=1", "-e", "BENCHCORE_ROOT=/work", "-e", "PYTHONPATH=/work/core",
           "-e", "PYTHONUNBUFFERED=1"]
    if Path("/etc/os-release").is_file():
        cmd += ["-v", "/etc/os-release:/host/os-release:ro"]
    if sys.stdin.isatty():
        cmd.append("-t")
    cmd += [image, "python3", "-m", "benchcore", *argv]
    signal.signal(signal.SIGTERM, _raise_interrupt)
    proc = subprocess.Popen(cmd)
    try:
        return proc.wait()
    except KeyboardInterrupt:
        # `docker stop` sends SIGTERM: the runner writes a partial bundle and removes its containers.
        log("interrupted: stopping the runner (it saves what was measured so far)")
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        docker.stop(runner_name(project), STOP_GRACE_S)
        proc.wait()
        docker.cleanup()  # whatever the runner could not remove itself
        return 130


def _raise_interrupt(signum, frame):
    raise KeyboardInterrupt


def interrupt_once():
    """Inside the runner: the first SIGINT or SIGTERM becomes a KeyboardInterrupt, later ones are ignored
    so that writing the partial bundle and the teardown cannot be interrupted again."""
    def handler(signum, frame):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)


def _select(items, wanted, kind):
    if not wanted:
        return list(items)
    ids = {i.id for i in items}
    unknown = [w for w in wanted if w not in ids]
    if unknown:
        sys.exit(f"unknown {kind}: {', '.join(unknown)} (known: {', '.join(sorted(ids))})")
    return [i for i in items if i.id in wanted]


def rotation(items, pass_index, passes):
    """Order of the implementations in one pass.

    A plain rotation would move everybody through the positions but keep the neighbours: B would always run
    right after A and inherit whatever A leaves behind (heat, page cache, database state). The base order
    0, 1, n-1, 2, n-2, ... (the first row of a Williams design) has a different distance between every pair
    of neighbours, so shifting it by a different amount per pass gives each implementation a different
    predecessor and a different position in every pass.
    """
    n = len(items)
    if n == 0:
        return []
    base = [0]
    for i in range(1, n):
        base.append((base[-1] + (i if i % 2 else -i)) % n)
    step = max(1, round(n / max(1, passes)))
    return [items[(b + pass_index * step) % n] for b in base]


def _context(project, domain, args, check_only=False):
    topo = layout.read_topology()
    try:
        allowed = os.sched_getaffinity(0)  # CPUs Docker may use (AllowedCPUs, isolcpus, a parent cpuset)
    except AttributeError:
        allowed = {cpu for cpu, _ in topo}
    usable = [(cpu, key) for cpu, key in topo if cpu in allowed]
    try:
        lay = (layout.parse_override(args.layout, {cpu for cpu, _ in usable}) if args.layout
               else layout.plan(usable, domain.service.get("cpus", 2)))
    except ValueError as e:
        sys.exit(f"--layout: {e}")
    if len(usable) < len(topo):
        lay["warnings"].append(f"only {len(usable)} of {len(topo)} CPUs are available to containers on this host")
    try:
        os.sched_setaffinity(0, set(lay["loadgen"]))
    except (AttributeError, OSError) as e:
        lay.setdefault("warnings", []).append(f"could not pin the runner to the load-generator CPUs: {e}")
    docker = Docker(project.label, log)
    options = {"passes": 0 if check_only else args.passes, "quick": bool(args.quick),
               "implementations": args.impl or "all", "scenarios": args.scenario or "all"}
    workdir = Path(tempfile.mkdtemp(prefix="benchcore-"))
    ctx = Context(project=project, domain=domain, docker=docker, layout=lay, options=options, workdir=workdir,
                  log=log, network=f"container:{runner_name(project)}")
    return ctx, topo


def execute(project, args, check_only=False):
    """Inside the runner container."""
    interrupt_once()
    domain = manifest.load_all(project.root)[args.domain]
    ctx, topo = _context(project, domain, args, check_only)
    harness = manifest.load_harness(domain)(ctx)
    impls = _select(domain.implementations, args.impl, "implementation")
    scenarios = _select(domain.scenarios, args.scenario, "scenario")
    if not args.scenario:  # optional scenarios (e.g. long soak runs) only run when named explicitly
        scenarios = [s for s in scenarios if not s.params.get("optional")]
    info = ctx.docker.info()
    mach = machine.fingerprint(topo, info, args.label)
    log(f"machine {mach['id']} · {mach['label']} · virtualization={mach['virtualization']}")
    log("layout: " + " · ".join(f"{k}={layout.cpuset(v)}" for k, v in ctx.layout.items()
                                if k in ("service", "environment", "loadgen", "idle") and v))
    for w in ctx.layout.get("warnings", []):
        log(f"warning: {w}")
    b = bundle.new(project, domain, mach, ctx.layout, ctx.options)
    b["scenarios"] = {s.id: s.to_public() for s in scenarios}
    results_dir = project.root / (args.results or project.run.get("results_dir", "results"))
    failed = []
    interrupted = False
    try:
        harness.prepare()
        active = []
        for impl in impls:
            log(f"build {impl.id}")
            entry = {"manifest": impl.to_public()}
            try:
                entry["image"] = harness.build(impl)
                problems = harness.check(impl)
            except Exception as e:  # build or start failure is reported, not fatal for the run
                problems = [f"{type(e).__name__}: {e}"]
            entry["check"] = "ok" if not problems else problems
            b["implementations"][impl.id] = entry
            if problems:
                failed.append(impl.id)
                text = "; ".join(problems)
                log(f"  check FAILED for {impl.id}: {text if len(text) <= 1200 else '...' + text[-1200:]}")
            else:
                log(f"  check ok ({entry['image']['size_bytes'] / 1e6:.0f} MB image)")
                active.append(impl)
        if check_only:
            return 1 if failed else 0
        for p in range(args.passes):
            order = rotation(active, p, args.passes)
            rec = {"index": p + 1, "order": [i.id for i in order], "started": bundle.now(), "results": {}}
            b["passes"].append(rec)
            for impl in order:
                log(f"pass {p + 1}/{args.passes} · {impl.id}")
                t0 = time.monotonic()
                try:
                    rec["results"][impl.id] = harness.measure(
                        impl, [s for s in scenarios if s.id not in impl.skip], p + 1)
                except Exception as e:
                    log(f"  measurement failed: {type(e).__name__}: {e}")
                    rec["results"][impl.id] = {"error": f"{type(e).__name__}: {e}", "scenarios": {}}
                log(f"  done in {time.monotonic() - t0:.0f} s")
                bundle.write(bundle.finish(b, "running"), results_dir)  # checkpoint after every implementation
        bundle.finish(b, "complete")
    except KeyboardInterrupt:
        interrupted = True
        log("interrupted, writing a partial bundle")
        bundle.finish(b, "partial")
    finally:
        try:
            harness.teardown()
        finally:
            shutil.rmtree(ctx.workdir, ignore_errors=True)
    if b["passes"]:
        path = bundle.write(b, results_dir)
        log(f"result bundle: {path.relative_to(project.root)}")
    if interrupted:
        return 130
    return 0 if not failed else 3
