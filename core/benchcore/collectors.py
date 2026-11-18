"""Operating-system level measurements (Linux, cgroup v2).

The runner executes in a privileged container with the host PID and cgroup namespaces, so it reads the
cgroup of every container directly and /proc/<pid>/smaps_rollup of every process (for PSS).
All readers return None when a value is not available on this machine instead of failing the run.
"""

import os
import threading
import time
from pathlib import Path

CGROUP_ROOT = Path(os.environ.get("BENCHCORE_CGROUP_ROOT", "/sys/fs/cgroup"))
PROC = Path(os.environ.get("BENCHCORE_PROC", "/proc"))
SYS_CPU = Path("/sys/devices/system/cpu")
RAPL = Path("/sys/class/powercap")


def _read(path):
    try:
        return Path(path).read_text()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def _kv(path):
    text = _read(path)
    if text is None:
        return None
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            try:
                out[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return out


def cgroup_of(container_id):
    """cgroup v2 directory of a container for the systemd and cgroupfs drivers."""
    for p in (CGROUP_ROOT / "system.slice" / f"docker-{container_id}.scope", CGROUP_ROOT / "docker" / container_id):
        if p.is_dir():
            return p
    for p in CGROUP_ROOT.glob(f"**/*{container_id}*"):
        if p.is_dir():
            return p
    return None


def own_cgroup():
    text = _read(PROC / "self" / "cgroup") or ""
    for line in text.splitlines():
        if line.startswith("0::"):
            p = CGROUP_ROOT / line[3:].lstrip("/")
            return p if p.is_dir() else None
    return None


def cpu_stat(cg):
    return _kv(Path(cg) / "cpu.stat") if cg else None


def memory_stat(cg):
    if not cg:
        return None
    s = _kv(Path(cg) / "memory.stat") or {}
    cur = _read(Path(cg) / "memory.current")
    peak = _read(Path(cg) / "memory.peak")
    return {"anon": s.get("anon"), "file": s.get("file"), "kernel": s.get("kernel"),
            "current": int(cur) if cur else None, "peak": int(peak) if peak else None}


def io_stat(cg):
    text = _read(Path(cg) / "io.stat") if cg else None
    if text is None:
        return None
    rb = wb = 0
    for line in text.splitlines():
        for item in line.split()[1:]:
            k, _, v = item.partition("=")
            if k == "rbytes":
                rb += int(v)
            elif k == "wbytes":
                wb += int(v)
    return {"rbytes": rb, "wbytes": wb}


def pss_kb(cg):
    """Proportional set size of all processes in the cgroup (shared pages counted once)."""
    procs = _read(Path(cg) / "cgroup.procs") if cg else None
    if procs is None:
        return None
    total, seen = 0, False
    for pid in procs.split():
        kv = _read(PROC / pid / "smaps_rollup")
        if kv is None:
            continue
        for line in kv.splitlines():
            if line.startswith("Pss:"):
                total += int(line.split()[1])
                seen = True
                break
    return total if seen else None


def proc_stat():
    """(total_jiffies, steal_jiffies) for the whole machine (user..steal; guest is already in user)."""
    text = _read(PROC / "stat") or ""
    for line in text.splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:9]]
            return sum(v), v[7]
    return None


def steal_pct(before, after):
    if not before or not after or after[0] == before[0]:
        return None
    return 100.0 * (after[1] - before[1]) / (after[0] - before[0])


def loadavg():
    text = _read(PROC / "loadavg")
    return float(text.split()[0]) if text else None


def cpu_mhz(cpus):
    vals = []
    for c in cpus:
        t = _read(SYS_CPU / f"cpu{c}" / "cpufreq" / "scaling_cur_freq")
        if t:
            vals.append(int(t) / 1000)
    return sum(vals) / len(vals) if vals else None


def rapl_domains():
    """Top-level RAPL package zones: [(energy_uj path, max range)]."""
    zones = []
    for z in sorted(RAPL.glob("intel-rapl:[0-9]")):
        e, m = z / "energy_uj", _read(z / "max_energy_range_uj")
        if _read(e) is not None:
            zones.append((e, int(m) if m else 2**32))
    return zones


def rapl_uj(zones):
    vals = [_read(e) for e, _ in zones]
    return [int(v) for v in vals] if zones and all(vals) else None


def rapl_delta_j(zones, before, after):
    if not before or not after:
        return None
    total = 0
    for (_, rng), b, a in zip(zones, before, after):
        total += (a - b) if a >= b else (a + rng - b)
    return total / 1e6


class Window:
    """Measures one time window: CPU of several cgroups, steal, energy, plus a background sampler for
    peak PSS/anon memory and CPU clock. Use as a context manager around the load generator."""

    def __init__(self, cgroups, sample_cg=None, freq_cpus=(), interval=1.0):
        self.cgroups = {k: v for k, v in cgroups.items() if v}
        self.sample_cg = sample_cg
        self.freq_cpus = list(freq_cpus)
        self.interval = interval
        self.zones = rapl_domains()
        self._stop = threading.Event()
        self.peak_pss_kb = None
        self.peak_anon = None
        self.mhz = []

    def _sample(self):
        while not self._stop.is_set():
            if self.sample_cg:
                p = pss_kb(self.sample_cg)
                if p is not None:
                    self.peak_pss_kb = max(self.peak_pss_kb or 0, p)
                m = memory_stat(self.sample_cg)
                if m and m["anon"] is not None:
                    self.peak_anon = max(self.peak_anon or 0, m["anon"])
            mhz = cpu_mhz(self.freq_cpus)
            if mhz:
                self.mhz.append(mhz)
            self._stop.wait(self.interval)

    def __enter__(self):
        self.load = loadavg()
        self.t0 = time.monotonic()
        self.stat0 = proc_stat()
        self.cpu0 = {k: cpu_stat(v) for k, v in self.cgroups.items()}
        self.io0 = {k: io_stat(v) for k, v in self.cgroups.items()}
        self.energy0 = rapl_uj(self.zones)
        self._thread = threading.Thread(target=self._sample, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._thread.join(timeout=5)
        self.elapsed = time.monotonic() - self.t0
        self.steal = steal_pct(self.stat0, proc_stat())
        self.energy_j = rapl_delta_j(self.zones, self.energy0, rapl_uj(self.zones))
        self.cpu = {}
        self.io = {}
        for k, cg in self.cgroups.items():
            a, b = self.cpu0.get(k), cpu_stat(cg)
            if a and b:
                self.cpu[k] = {f: b.get(f, 0) - a.get(f, 0) for f in
                               ("usage_usec", "user_usec", "system_usec", "nr_throttled", "throttled_usec")}
            i0, i1 = self.io0.get(k), io_stat(cg)
            if i0 and i1:
                self.io[k] = {f: i1[f] - i0[f] for f in i0}
        return False
