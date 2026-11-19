"""Command line interface. Run `python -m benchcore --help` or the `benchmania` wrapper at the repository root."""

import argparse
import os
import platform
import shutil
import sys
from pathlib import Path

from . import __version__, bundle, layout, manifest, project as project_mod, publish, runner


def _domain(project, did):
    domains = manifest.load_all(project.root)
    if did not in domains:
        sys.exit(f"unknown domain '{did}' (known: {', '.join(domains)})")
    return domains[did]


def cmd_list(project, args):
    domains = manifest.load_all(project.root)
    for did, d in domains.items():
        if args.domain and did != args.domain:
            continue
        print(f"{did}  [{d.status}]  {d.title}")
        print("  scenarios:       " + ", ".join(s.id for s in d.scenarios))
        print("  implementations: " + ", ".join(i.id for i in d.implementations))


def cmd_validate(project, args):
    problems = []
    try:
        domains = manifest.load_all(project.root)
    except manifest.ManifestError as e:
        print("\n".join(e.problems))
        return 1
    for d in domains.values():
        try:
            harness_cls = manifest.load_harness(d)
        except manifest.ManifestError as e:
            problems += e.problems
            continue
        h = harness_cls.__new__(harness_cls)  # static validation only, no context needed
        for s in d.scenarios:
            problems += h.validate_scenario(s)
        for i in d.implementations:
            problems += [f"{i.path}: {p}" for p in harness_cls.validate_implementation(h, i)]
    results_dir = project.root / project.run.get("results_dir", "results")
    n = 0
    for path, b in bundle.load_all(results_dir):
        n += 1
        d = domains.get(b.get("domain"))
        problems += [f"{path}: {p}" for p in bundle.verify(b, d, path)]
    if problems:
        print("\n".join(problems))
        return 1
    print(f"ok: {len(domains)} domains, {sum(len(d.implementations) for d in domains.values())} implementations, "
          f"{sum(len(d.scenarios) for d in domains.values())} scenarios, {n} result bundles")
    return 0


def cmd_publish(project, args):
    out = Path(args.out) if args.out else project.root / "site" / "src" / "data"
    for f in publish.build(project, out, include_examples=args.include_examples):
        print(f"wrote {f}")
    return 0


def cmd_doctor(project, args):
    from .docker import Docker
    ok = True
    system = platform.system()
    if system != "Linux":
        # Docker Desktop reports a Linux engine with cgroup v2 on Windows and macOS; that is its VM, not this machine.
        print(f"system:      {system}  <- measuring needs Linux")
        ok = False
    d = Docker(project.label)
    v = d.available()
    print(f"docker:      {'ok ' + v if v else 'NOT reachable'}")
    ok &= bool(v)
    if v:
        info = d.info()
        cg = info.get("CgroupVersion")
        print(f"cgroup:      v{cg} ({info.get('CgroupDriver')})" + ("" if cg == "2" else "  <- cgroup v2 required"))
        ok &= cg == "2"
        rootless = any("rootless" in str(o) for o in info.get("SecurityOptions", []))
        print(f"rootless:    {'yes  <- CPU pinning and PSS need rootful Docker' if rootless else 'no'}")
        ok &= not rootless
        print(f"cpus:        {info.get('NCPU')}  memory: {info.get('MemTotal', 0) / 1024**3:.1f} GiB")
    topo = layout.read_topology()
    if topo:
        plan = layout.plan(topo)
        print("layout:      " + " · ".join(f"{k}={layout.cpuset(v)}" for k, v in plan.items()
                                         if k in ("service", "environment", "loadgen") and v))
        for w in plan["warnings"]:
            print(f"warning:     {w}")
    return 0 if ok else 1


def cmd_scaffold(project, args):
    domain = _domain(project, args.domain)
    src = domain.implementation(args.source).path
    dst = src.parent / args.id
    if dst.exists():
        sys.exit(f"{dst} already exists")
    if not manifest.ID_RE.match(args.id):
        sys.exit("id must be lowercase letters, digits and dashes")
    shutil.copytree(src, dst)
    manifest_file = dst / "impl.toml"
    text = manifest_file.read_text(encoding="utf-8").replace(f'id = "{args.source}"', f'id = "{args.id}"')
    manifest_file.write_text(text, encoding="utf-8")
    print(f"created {dst.relative_to(project.root)} from {args.source}; edit impl.toml, Dockerfile and sources")
    return 0


def cmd_cleanup(project, args):
    from .docker import Docker
    n = Docker(project.label).cleanup()
    print(f"removed {n} containers")
    return 0


def _inside_or_launch(project, args, argv, check_only):
    if os.environ.get(runner.INSIDE_ENV):
        return runner.execute(project, args, check_only=check_only)
    _domain(project, args.domain)  # validate before building anything
    return runner.launch(project, argv)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    project = project_mod.load()
    p = argparse.ArgumentParser(prog=project.slug, description=f"{project.name}: {project.tagline}")
    p.add_argument("--version", action="version", version=f"{project.name} engine {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    def run_args(sp, with_passes=True):
        sp.add_argument("domain")
        sp.add_argument("--impl", nargs="+", help="only these implementations")
        sp.add_argument("--scenario", nargs="+", help="only these scenarios")
        sp.add_argument("--layout", help="manual CPU layout, e.g. 'service=0,1;environment=2,3;loadgen=4-7'")
        sp.add_argument("--label", help="human-readable machine label stored in the result")
        sp.add_argument("--results", help="results directory relative to the repository root")
        sp.add_argument("--quick", action="store_true", help="short durations for smoke tests (not publishable)")
        if with_passes:
            sp.add_argument("--passes", type=int, default=project.run.get("passes", 5))
        else:
            sp.set_defaults(passes=0)

    run_args(sub.add_parser("run", help="build, check and measure a domain; writes a result bundle"))
    run_args(sub.add_parser("check", help="build and functionally check implementations (no measurement)"), False)
    sp = sub.add_parser("list", help="list domains, scenarios and implementations")
    sp.add_argument("domain", nargs="?")
    sub.add_parser("validate", help="validate manifests and result bundles")
    sp = sub.add_parser("publish", help="build the website dataset from result bundles")
    sp.add_argument("--out", help="output directory (default site/src/data)")
    sp.add_argument("--include-examples", action="store_true")
    sub.add_parser("doctor", help="check that this machine can run benchmarks")
    sp = sub.add_parser("scaffold", help="create a new implementation by copying an existing one")
    sp.add_argument("domain")
    sp.add_argument("id")
    sp.add_argument("--from", dest="source", required=True)
    sub.add_parser("cleanup", help="remove containers left over from an aborted run")

    args = p.parse_args(argv)
    if args.command == "run":
        return _inside_or_launch(project, args, argv, check_only=False)
    if args.command == "check":
        return _inside_or_launch(project, args, argv, check_only=True)
    return {"list": cmd_list, "validate": cmd_validate, "publish": cmd_publish, "doctor": cmd_doctor,
            "scaffold": cmd_scaffold, "cleanup": cmd_cleanup}[args.command](project, args) or 0
