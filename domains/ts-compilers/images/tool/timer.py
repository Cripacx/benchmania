"""Runs one command several times inside the measurement container and reports each run as JSON.

usage: python3 timer.py '<json spec>'

spec: {"argv": [...], "cwd": dir, "env": {...}, "runs": n, "clean": dir or null, "count": [suffix, ...]}

For every run, `clean` (if given) is emptied first, outside the timed window. The clock starts right before
the command is spawned and stops when wait4 returns, so it covers the whole command (a launcher and the
process it starts) and nothing of `docker exec`. wait4 also returns the resource usage of the command
and of every descendant it waited for: CPU time is their user + system time, max RSS is the largest
resident set of any single one of those processes (the kernel reports a maximum, not a sum). Output goes
to a file and is returned in full, so that the caller can verify every run. After the run, files below
`clean` whose names end in one of the `count` suffixes are counted.
"""

import json
import os
import shutil
import sys
import tempfile
import time


def count_files(root, suffixes):
    counts = {s: 0 for s in suffixes}
    for _, _, files in os.walk(root):
        for name in files:
            for s in suffixes:
                if name.endswith(s):
                    counts[s] += 1
    return counts


def run_once(spec, env):
    clean = spec.get("clean")
    if clean:  # empty it, but keep the directory: it may be a mount point
        os.makedirs(clean, exist_ok=True)
        for entry in os.scandir(clean):
            if entry.is_dir(follow_symlinks=False):
                shutil.rmtree(entry.path)
            else:
                os.unlink(entry.path)
    with tempfile.TemporaryFile() as out:
        actions = [(os.POSIX_SPAWN_DUP2, out.fileno(), 1), (os.POSIX_SPAWN_DUP2, out.fileno(), 2)]
        t0 = time.perf_counter_ns()
        pid = os.posix_spawnp(spec["argv"][0], spec["argv"], env, file_actions=actions)
        _, status, ru = os.wait4(pid, 0)
        t1 = time.perf_counter_ns()
        out.seek(0)
        text = out.read().decode("utf-8", "replace")
    run = {"wall_ms": (t1 - t0) / 1e6, "cpu_ms": (ru.ru_utime + ru.ru_stime) * 1000,
           "maxrss_kib": ru.ru_maxrss, "exit": os.waitstatus_to_exitcode(status), "output": text}
    if clean and spec.get("count"):
        run["files"] = count_files(clean, spec["count"])
    return run


def main():
    spec = json.loads(sys.argv[1])
    os.chdir(spec["cwd"])
    env = {**os.environ, **spec.get("env", {})}
    runs = [run_once(spec, env) for _ in range(int(spec["runs"]))]
    json.dump(runs, sys.stdout)


if __name__ == "__main__":
    main()
