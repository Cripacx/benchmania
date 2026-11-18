"""Machine fingerprint: everything needed to interpret and compare a result from another machine.

Hostnames and serial numbers are deliberately not recorded. The machine id is a hash of stable hardware
facts, so repeated runs on the same machine group together without identifying its owner.
"""

import hashlib
import os
import platform
import re
from pathlib import Path

from . import collectors


def _read(path):
    try:
        return Path(path).read_text().strip()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def _os_release():
    for p in ("/host/os-release", "/etc/os-release"):
        text = _read(p)
        if text:
            kv = dict(line.split("=", 1) for line in text.splitlines() if "=" in line)
            return {"name": kv.get("PRETTY_NAME", "").strip('"'), "source": "host" if p.startswith("/host") else "runner"}
    return {"name": platform.platform(), "source": "python"}


def _cpuinfo():
    text = _read("/proc/cpuinfo") or ""
    model = re.search(r"^model name\s*:\s*(.+)$", text, re.M)
    vendor = re.search(r"^vendor_id\s*:\s*(.+)$", text, re.M)
    flags = re.search(r"^flags\s*:\s*(.+)$", text, re.M)
    return {
        "model": model.group(1).strip() if model else platform.processor() or "unknown",
        "vendor": vendor.group(1).strip() if vendor else None,
        "hypervisor_flag": bool(flags and "hypervisor" in flags.group(1).split()),
    }


def _virtualization(cpu):
    vendor = (_read("/sys/class/dmi/id/sys_vendor") or "").lower()
    product = (_read("/sys/class/dmi/id/product_name") or "").lower()
    known = {"qemu": "kvm", "kvm": "kvm", "vmware": "vmware", "microsoft": "hyper-v", "xen": "xen",
             "amazon ec2": "aws", "google": "gcp", "firecracker": "firecracker", "innotek": "virtualbox"}
    for key, name in known.items():
        if key in vendor or key in product:
            return name
    if cpu["hypervisor_flag"]:
        return "unknown-hypervisor"
    if Path("/.dockerenv").exists() and os.environ.get("BENCHCORE_DESKTOP"):
        return "docker-desktop"
    return "none"


def _cpu_policy():
    gov = _read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
    driver = _read("/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver")
    max_khz = _read("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
    no_turbo = _read("/sys/devices/system/cpu/intel_pstate/no_turbo")
    boost = _read("/sys/devices/system/cpu/cpufreq/boost")
    turbo = None
    if no_turbo is not None:
        turbo = no_turbo == "0"
    elif boost is not None:
        turbo = boost == "1"
    return {"governor": gov, "driver": driver, "max_mhz": int(max_khz) // 1000 if max_khz else None, "turbo": turbo}


def machine_id(model, logical, cores, mem_gib, virtualization, board_vendor, board_name):
    """Stable, anonymous id: same hardware -> same id, nothing that identifies the owner."""
    stable = f"{model}|{logical}|{cores}|{round(mem_gib or 0)}|{virtualization}|{board_vendor}|{board_name}"
    return hashlib.sha256(stable.encode()).hexdigest()[:12]


def short_label(model, logical):
    short = re.sub(r"\s+(\d+-Core Processor|CPU @ .*|Processor)$", "", model).replace("(R)", "").replace("(TM)", "")
    return f"{short.strip()} · {logical} threads"


def fingerprint(topology, docker_info=None, label=None):
    cpu = _cpuinfo()
    cores = {key for _, key in topology}
    meminfo = _read("/proc/meminfo") or ""
    mem = re.search(r"^MemTotal:\s+(\d+) kB", meminfo, re.M)
    mem_gib = round(int(mem.group(1)) / 1024**2, 1) if mem else None
    virt = _virtualization(cpu)
    d = docker_info or {}
    mid = machine_id(cpu["model"], len(topology), len(cores), mem_gib, virt,
                     _read("/sys/class/dmi/id/board_vendor"), _read("/sys/class/dmi/id/board_name"))
    return {
        "id": mid,
        "label": label or short_label(cpu["model"], len(topology)),
        "cpu": {"model": cpu["model"], "vendor": cpu["vendor"], "logical": len(topology), "physical_cores": len(cores),
                "sockets": len({k[0] for k in cores}), "smt": len(topology) > len(cores), **_cpu_policy()},
        "memory_gib": mem_gib,
        "kernel": platform.release(),
        "arch": platform.machine(),
        "os": _os_release(),
        "virtualization": virt,
        "rapl": bool(collectors.rapl_domains()),
        "docker": {"version": d.get("ServerVersion"), "cgroup_driver": d.get("CgroupDriver"),
                   "cgroup_version": d.get("CgroupVersion"), "storage_driver": d.get("Driver"),
                   "rootless": any("rootless" in str(o) for o in d.get("SecurityOptions", []))},
    }
