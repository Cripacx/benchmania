"""CPU layout: which logical CPUs the service, its environment (e.g. a database) and the load generator get.

Rules, in order:
1. The service gets `service_cpus` logical CPUs, one per physical core. The SMT siblings of those cores are
   assigned to no role (`idle`), so no work of the benchmark runs on them.
2. The remaining physical cores (with all their threads) are split between the environment and the load
   generator; the load generator gets the larger half because it must never be the bottleneck.
3. On machines too small for this, roles share CPUs and the layout carries a warning that ends up in the
   result's quality flags.

The layout is CPU affinity: containers get their role's CPUs as a cpuset, the load generator and the runner's
own process are pinned to the load generator's CPUs.
It does not reserve them (other processes, kernel threads and interrupts can still run there), and on a
virtual machine the CPUs are virtual CPUs whose placement on physical cores is up to the hypervisor.
"""

from collections import OrderedDict
from pathlib import Path


def read_topology(sysfs="/sys/devices/system/cpu"):
    """[(cpu, core_key)] for online CPUs; core_key groups SMT siblings of one physical core."""
    base = Path(sysfs)
    cpus = []
    for d in sorted(base.glob("cpu[0-9]*"), key=lambda p: int(p.name[3:])):
        cpu = int(d.name[3:])
        online = d / "online"
        if online.exists() and online.read_text().strip() == "0":
            continue
        topo = d / "topology"
        try:
            pkg = int((topo / "physical_package_id").read_text())
        except (FileNotFoundError, ValueError):
            pkg = 0
        # The sibling list names the threads of one core directly. core_id alone is not unique: on ARM
        # big.LITTLE systems it restarts in every cluster, which would merge separate cores.
        core = cpu
        for name in ("core_cpus_list", "thread_siblings_list"):
            try:
                core = _parse_cpus((topo / name).read_text())[0]
                break
            except (FileNotFoundError, ValueError, IndexError):
                continue
        cpus.append((cpu, (pkg, core)))
    return cpus


def _parse_cpus(spec):
    """'0,6' or '0-3,8' -> sorted list of CPU numbers."""
    cpus = []
    for item in filter(None, (i.strip() for i in spec.split(","))):
        a, _, b = item.partition("-")
        cpus += list(range(int(a), int(b) + 1)) if b else [int(a)]
    return sorted(cpus)


def plan(cpus, service_cpus=2):
    cores = OrderedDict()
    for cpu, key in sorted(cpus):
        cores.setdefault(key, []).append(cpu)
    core_list = list(cores.values())
    warnings = []
    if len(core_list) >= service_cpus + 2:
        service_cores, rest = core_list[:service_cpus], core_list[service_cpus:]
        service = [c[0] for c in service_cores]
        idle = [t for c in service_cores for t in c[1:]]
        env_n = max(1, len(rest) // 2)
        env = [t for c in rest[:env_n] for t in c]
        loadgen = [t for c in rest[env_n:] for t in c]
    else:
        flat = [t for c in core_list for t in c]
        if len(flat) >= service_cpus + 2:
            service = flat[:service_cpus]
            rest = flat[service_cpus:]
            env, loadgen, idle = rest[: max(1, len(rest) // 2)], rest[max(1, len(rest) // 2):], []
            warnings.append("not enough physical cores: the service shares cores with other work via SMT")
        else:
            service, env, loadgen, idle = flat, flat, flat, []
            warnings.append("fewer CPUs than roles: service, environment and load generator share all CPUs")
    return {"service": service, "environment": env, "loadgen": loadgen, "idle": idle,
            "smt": any(len(c) > 1 for c in core_list), "warnings": warnings}


def cpuset(cpus):
    return ",".join(str(c) for c in sorted(cpus))


ROLES = ("service", "environment", "loadgen")


def parse_override(text, known=None):
    """'service=0,1;environment=2,3;loadgen=4-7' -> layout dict (ranges allowed; `idle=` is optional).

    Every role needs CPUs: a role without a cpuset would run unpinned, on the service's cores. `known` is
    the set of CPUs that exist and may be used; overlapping roles are allowed but end up as a warning.
    """
    out = {"service": [], "environment": [], "loadgen": [], "idle": [], "smt": None, "warnings": ["manual layout"]}
    for part in filter(None, (p.strip() for p in text.split(";"))):
        role, _, spec = part.partition("=")
        role = role.strip()
        if role not in (*ROLES, "idle"):
            raise ValueError(f"unknown role in layout: {role!r} (use {', '.join(ROLES)} or idle)")
        try:
            out[role] = _parse_cpus(spec)
        except ValueError:
            raise ValueError(f"cannot read the CPU list of '{role}': {spec!r}") from None
    missing = [r for r in ROLES if not out[r]]
    if missing:
        raise ValueError(f"layout needs CPUs for: {', '.join(missing)}")
    if known is not None:
        unknown = sorted({c for r in (*ROLES, "idle") for c in out[r]} - set(known))
        if unknown:
            raise ValueError(f"layout names CPUs that are not available: {cpuset(unknown)}")
    for i, a in enumerate(ROLES):
        for b in ROLES[i + 1:]:
            if set(out[a]) & set(out[b]):
                out["warnings"].append(f"{a} and {b} share CPUs {cpuset(set(out[a]) & set(out[b]))}")
    return out
