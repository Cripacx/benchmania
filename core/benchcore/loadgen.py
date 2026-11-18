"""HTTP load generators.

- wrk: closed loop (fixed number of connections, as fast as possible) -> maximum throughput.
- oha: open loop (fixed request rate) with coordinated-omission correction -> latency at a given load.

wrk results come from a Lua `done` hook that prints one JSON line, so nothing depends on wrk's text format.
"""

import json
import subprocess
from pathlib import Path

from .units import docker_duration, seconds

MARK = "BENCHCORE_JSON"
PERCENTILES = (50, 75, 90, 99, 99.9, 99.99)

REPORT_LUA = r"""
done = function(summary, latency, requests)
  local e = summary.errors
  local parts = {}
  local pcts = {50, 75, 90, 99, 99.9, 99.99}
  for _, q in ipairs(pcts) do
    local key = string.gsub(tostring(q), "%.", "_")
    table.insert(parts, string.format('"p%s":%d', key, latency:percentile(q)))
  end
  io.write(string.format(
    '%s{"requests":%d,"duration_us":%d,"bytes":%d,' ..
    '"errors":{"connect":%d,"read":%d,"write":%d,"status":%d,"timeout":%d},' ..
    '"latency_us":{"min":%d,"max":%d,"mean":%.3f,"stdev":%.3f,%s}}\n',
    "MARK", summary.requests, summary.duration, summary.bytes,
    e.connect, e.read, e.write, e.status, e.timeout,
    latency.min, latency.max, latency.mean, latency.stdev, table.concat(parts, ",")))
end
""".replace("MARK", MARK)


def lua_escape(text):
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def wrk_script(method="GET", body=None, headers=None):
    lines = []
    if method != "GET":
        lines.append(f'wrk.method = "{method}"')
    for k, v in (headers or {}).items():
        lines.append(f'wrk.headers["{lua_escape(k)}"] = "{lua_escape(v)}"')
    if body is not None:
        lines.append(f'wrk.body = "{lua_escape(body)}"')
    return "\n".join(lines) + "\n" + REPORT_LUA


def parse_wrk(stdout):
    for line in stdout.splitlines():
        if line.startswith(MARK):
            raw = json.loads(line[len(MARK):])
            break
    else:
        raise ValueError("wrk produced no report line:\n" + stdout[-1500:])
    secs = raw["duration_us"] / 1e6
    lat = raw["latency_us"]
    errors = raw["errors"]
    n_err = sum(errors.values())
    # wrk counts every completed response as a request, including 4xx/5xx. Throughput is successful
    # responses only, so a service that fails fast is not rewarded for it.
    good = max(0, raw["requests"] - errors.get("status", 0))
    out = {
        "requests": raw["requests"],
        "duration_s": secs,
        "rps": good / secs if secs else 0.0,
        "bytes_per_resp": raw["bytes"] / raw["requests"] if raw["requests"] else None,
        "errors": n_err,
        "error_detail": errors,
        "error_rate": n_err / raw["requests"] if raw["requests"] else 1.0,
        "latency_mean_ms": lat["mean"] / 1000,
        "latency_stdev_ms": lat["stdev"] / 1000,
        "latency_max_ms": lat["max"] / 1000,
    }
    for q in PERCENTILES:
        key = str(q).replace(".", "_")
        out[f"latency_p{key}_ms"] = lat[f"p{key}"] / 1000
    return out


def parse_oha(stdout):
    d = json.loads(stdout)
    s, lp = d["summary"], d.get("latencyPercentiles", {})
    codes = d.get("statusCodeDistribution", {})
    # Requests still in flight when the time is up are cut off by oha itself; that is not a service error.
    errs = {k: v for k, v in d.get("errorDistribution", {}).items() if "deadline" not in k.lower()}
    total = sum(codes.values()) + sum(errs.values())
    good = sum(v for k, v in codes.items() if str(k).startswith(("2", "3")))
    bad = total - good
    ms = lambda key: lp[key] * 1000 if lp.get(key) is not None else None
    if s.get("total"):  # wall time of the run in seconds
        rps = good / s["total"]
    else:
        rps = s["requestsPerSec"] * good / total if total and s.get("requestsPerSec") is not None else None
    return {
        "requests": total,
        "rps": rps,  # successful responses per second
        "errors": bad,
        "error_rate": bad / total if total else 1.0,
        "success_rate": s.get("successRate"),
        "latency_mean_ms": s["average"] * 1000 if s.get("average") is not None else None,
        "latency_max_ms": s["slowest"] * 1000 if s.get("slowest") is not None else None,
        "latency_p50_ms": ms("p50"), "latency_p75_ms": ms("p75"), "latency_p90_ms": ms("p90"),
        "latency_p99_ms": ms("p99"), "latency_p99_9_ms": ms("p99.9"), "latency_p99_99_ms": ms("p99.99"),
        "bytes_per_resp": s.get("sizePerRequest"),
    }


def _pin(cpus):
    return ["taskset", "-c", ",".join(map(str, cpus))] if cpus else []


def _run(tool, cmd, duration, slack_s):
    """Run a load generator; it must end on its own shortly after `duration`, whatever the service does."""
    limit = seconds(duration) + slack_s + 30
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=limit)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{tool} did not finish within {limit:.0f} s") from None
    if p.returncode != 0:
        raise RuntimeError(f"{tool} failed: {p.stderr.strip()[-500:]}")
    return p.stdout


def wrk(url, connections, duration, cpus, workdir, method="GET", body=None, headers=None, timeout_s=10):
    threads = max(1, min(len(cpus) or 1, connections))
    script = Path(workdir) / f"wrk-{abs(hash((method, body, url))) % 10**8}.lua"
    script.write_text(wrk_script(method, body, headers))
    cmd = _pin(cpus) + ["wrk", f"-t{threads}", f"-c{connections}", f"-d{docker_duration(duration)}",
                        f"--timeout", f"{timeout_s}s", "-s", str(script), url]
    return parse_wrk(_run("wrk", cmd, duration, timeout_s))


def oha(url, rate, connections, duration, cpus, method="GET", body_file=None, headers=None):
    cmd = _pin(cpus) + ["oha", "-z", docker_duration(duration), "-q", str(rate), "-c", str(connections),
                        "--latency-correction", "--no-tui", "--output-format", "json", "-m", method]
    for k, v in (headers or {}).items():
        cmd += ["-H", f"{k}: {v}"]
    if body_file:
        cmd += ["-D", str(body_file)]
    cmd.append(url)
    return parse_oha(_run("oha", cmd, duration, 30))
