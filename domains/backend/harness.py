"""Backend domain harness: HTTP services with PostgreSQL.

Per implementation and pass:
  1. restore the table content, VACUUM, CHECKPOINT, reset statement statistics (equal starting conditions);
     repeated after every workload that writes, so later scenarios do not see its updates
  2. `startup`: start the container N times, time to first 200; idle memory
  3. `cold`: full load right after start, no warm-up
  4. global warm-up over every endpoint, then each `http` scenario: warm-up + measured window
  5. `rate`: fixed request rate (open loop), `soak`: long fixed-rate run in slices
Each measured window records service/database/load-generator CPU from cgroups, peak PSS, steal time,
CPU clock, RAPL energy and the database work per request (pg_stat_statements).
"""

import importlib.util
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

from benchcore import collectors, loadgen
from benchcore.harness import Harness
from benchcore.layout import cpuset
from benchcore.units import seconds

MIB = 2**20
WORK_TOLERANCE = 0.03  # measured DB statements per request may deviate 3 % (window boundaries)
RATE_REACHED = 0.97    # a fixed-rate scenario must reach this share of its target rate
SATURATED = 0.9        # busy share of the load generator's or the database's CPUs that limits the result
DB_ENV = {"POSTGRES_USER": "bench", "POSTGRES_PASSWORD": "bench", "POSTGRES_DB": "bench"}
DB_ARGS = ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=top",
           "-c", "max_connections=400", "-c", "shared_buffers=256MB", "-c", "synchronous_commit=off",
           "-c", "listen_addresses=127.0.0.1"]


def _checks():
    """Load checks.py from this directory (domains are not packages, so no plain import)."""
    spec = importlib.util.spec_from_file_location("benchcore_backend_checks", Path(__file__).with_name("checks.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BackendHarness(Harness):
    scenario_kinds = {
        "startup": [],
        "cold": ["path"],
        "http": ["path"],
        "rate": ["path", "rate"],
        "soak": ["path", "rate", "slices", "slice_duration"],
    }

    def __init__(self, ctx):
        super().__init__(ctx)
        d = ctx.domain
        self.defaults = dict(d.defaults)
        if ctx.quick:
            self.defaults.update(d.data.get("quick", {}))
        self.base = f"http://127.0.0.1:{d.service.get('port', 8080)}"
        self.svc = ctx.project.container("svc")
        self.db = ctx.project.container("db")
        self.data = d.path / "loadgen"
        self.max_steal = float(ctx.project.run.get("max_steal_percent", 2.0))
        self.max_retries = int(ctx.project.run.get("max_retries", 2))
        self.svc_cg = self.db_cg = self.own_cg = None
        self.dirty = True  # the table differs from its original content (functional checks write, too)

    # --- static validation ---------------------------------------------------------------------------
    def validate_scenario(self, scenario):
        problems = super().validate_scenario(scenario)
        body = scenario.params.get("body")
        if body and not (scenario.path.parent.parent / "loadgen" / body).is_file():
            problems.append(f"{scenario.path}: body file loadgen/{body} not found")
        return problems

    def validate_implementation(self, impl):
        problems = []
        for key in ("runtime", "framework", "versions"):
            if key not in impl.data:
                problems.append(f"impl.toml should declare '{key}'")
        return problems

    # --- environment ----------------------------------------------------------------------------------
    def psql(self, sql):
        return self.ctx.docker.exec(self.db, "psql", "-U", "bench", "-d", "bench", "-Atc", sql).stdout.strip()

    def prepare(self):
        d, lay = self.ctx.docker, self.ctx.layout
        tag = self.ctx.project.container("backend-postgres")
        self.ctx.log("starting PostgreSQL")
        d.build(tag, self.ctx.domain.path / "environment" / "postgres")
        self.db_image = d.image(tag)
        d.run(self.db, tag, network=self.ctx.network, cpuset=cpuset(lay["environment"]), env=DB_ENV, command=DB_ARGS)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            # The image's entrypoint runs init.sql on a temporary server that only has a unix socket, then
            # restarts. Only the final server listens on TCP, so that is what "ready" has to mean.
            up = d.exec(self.db, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "bench", "-d", "bench", check=False)
            if up.returncode == 0:
                p = d.exec(self.db, "psql", "-U", "bench", "-d", "bench", "-Atc", "SELECT count(*) FROM world",
                           check=False)
                if p.returncode == 0 and p.stdout.strip() == "10000":
                    break
            time.sleep(0.5)
        else:
            raise RuntimeError("PostgreSQL did not become ready:\n" + d.logs(self.db, 30))
        self.db_cg = collectors.cgroup_of(d.container_id(self.db))
        self.own_cg = collectors.own_cgroup()
        self.ctx.log(f"PostgreSQL ready ({self.psql('SHOW server_version')})")

    def teardown(self):
        self.ctx.docker.remove(self.svc)
        self.ctx.docker.remove(self.db)

    def reset_db(self):
        """Same starting point for everybody: original rows, compact table, no pending checkpoint."""
        self.psql("SELECT bench_reset()")
        self.psql("VACUUM ANALYZE world")
        self.psql("CHECKPOINT")
        self.psql("SELECT pg_stat_statements_reset()")
        self.dirty = False

    def _clean_db(self):
        if self.dirty:
            self.reset_db()

    @staticmethod
    def _writes(s):
        return bool(s.params.get("work", {}).get("update")) or s.kind == "soak"

    def db_counts(self):
        """(SELECT calls, UPDATE calls) on table world since the last reset."""
        out = self.psql("SELECT calls, upper(left(ltrim(query), 6)) FROM pg_stat_statements WHERE query ILIKE '%world%'")
        sel = upd = 0
        for line in filter(None, out.splitlines()):
            calls, _, kind = line.partition("|")
            if kind == "SELECT":
                sel += int(calls)
            elif kind == "UPDATE":
                upd += int(calls)
        return sel, upd

    # --- service lifecycle ----------------------------------------------------------------------------
    def _get(self, path, timeout=2.0):
        with urllib.request.urlopen(self.base + path, timeout=timeout) as r:
            return r.status, r.headers, r.read()

    def wait_ready(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if self._get("/json", timeout=0.5)[0] == 200:
                    return True
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.005)
        return False

    def start_service(self, impl):
        """Fresh container; returns milliseconds from `docker start` to the first successful response."""
        svc = self.ctx.domain.service
        self.ctx.docker.create(self.svc, self.image_tag(impl), network=self.ctx.network,
                               cpuset=cpuset(self.ctx.layout["service"]), cpus=svc.get("cpus"),
                               memory=svc.get("memory"), env=impl.run.get("env"), untrusted=True)
        t0 = time.monotonic()
        self.ctx.docker.start(self.svc)
        if not self.wait_ready(seconds(self.defaults.get("ready_timeout", "120s"))):
            raise RuntimeError(f"{impl.id} did not answer GET /json:\n" + self.ctx.docker.logs(self.svc, 40))
        ms = (time.monotonic() - t0) * 1000
        self.svc_cg = collectors.cgroup_of(self.ctx.docker.container_id(self.svc))
        return ms

    # --- functional check -----------------------------------------------------------------------------
    def check(self, impl):
        try:
            self.start_service(impl)
            problems = _checks().run_checks(self.base, self.data, self.psql)
            for s in self.ctx.domain.scenarios:
                if s.kind != "http":
                    continue
                r = self._wrk(s, connections=32, duration="1s")
                if r["errors"]:
                    problems.append(f"{s.params.get('method', 'GET')} {s.params['path']}: {r['errors']} errors in a short burst")
            return problems
        except Exception as e:
            return [f"{type(e).__name__}: {e}"]
        finally:
            self.ctx.docker.remove(self.svc)

    # --- measurement ----------------------------------------------------------------------------------
    def _wrk(self, s, connections=None, duration=None):
        p = s.params
        body = (self.data / p["body"]).read_text(encoding="utf-8") if p.get("body") else None
        return loadgen.wrk(self.base + p["path"], connections or p.get("connections", self.defaults["connections"]),
                           duration or self._duration(s), self.ctx.layout["loadgen"], self.ctx.workdir,
                           method=p.get("method", "GET"), body=body, headers=p.get("headers"))

    def _duration(self, s, key="duration"):
        if self.ctx.quick:
            return self.defaults["duration"]
        return s.params.get(key, self.defaults[key])

    def _window(self):
        return collectors.Window({"svc": self.svc_cg, "db": self.db_cg, "lg": self.own_cg}, sample_cg=self.svc_cg,
                                 freq_cpus=self.ctx.layout["service"])

    def _metrics(self, s, r, w, work_delta):
        reqs = r.get("requests") or 1
        m = {k: v for k, v in r.items() if isinstance(v, (int, float)) and k not in ("requests", "duration_s", "success_rate")}
        cpu, db, lg = w.cpu.get("svc"), w.cpu.get("db"), w.cpu.get("lg")
        if cpu and cpu["usage_usec"]:
            m["cpu_us_per_req"] = cpu["usage_usec"] / reqs
            m["cpu_cores"] = cpu["usage_usec"] / 1e6 / w.elapsed
            m["cpu_user_share"] = cpu["user_usec"] / cpu["usage_usec"]
            m["throttled_ms"] = cpu["throttled_usec"] / 1000
        if db:
            m["db_cpu_us_per_req"] = db["usage_usec"] / reqs
            m["db_cpu_util"] = db["usage_usec"] / 1e6 / (w.elapsed * max(1, len(self.ctx.layout["environment"])))
        if lg:
            m["loadgen_cpu_util"] = lg["usage_usec"] / 1e6 / (w.elapsed * max(1, len(self.ctx.layout["loadgen"])))
        if w.peak_pss_kb:
            m["mem_pss_peak_mib"] = w.peak_pss_kb / 1024
        if w.peak_anon:
            m["mem_anon_peak_mib"] = w.peak_anon / MIB
        if w.io.get("svc"):
            m["io_write_kib"] = w.io["svc"]["wbytes"] / 1024
        if w.steal is not None:
            m["steal_pct"] = w.steal
        if w.load is not None:
            m["host_load"] = w.load
        if w.mhz:
            m["cpu_mhz"] = statistics.fmean(w.mhz)
        if w.energy_j:
            m["package_energy_j"] = w.energy_j
            m["energy_mj_per_req"] = w.energy_j * 1000 / reqs
        flags = []
        work = s.params.get("work", {})
        if work_delta is not None:
            sel, upd = work_delta
            m["db_select_per_req"], m["db_update_per_req"] = sel / reqs, upd / reqs
            for key, measured in (("select", m["db_select_per_req"]), ("update", m["db_update_per_req"])):
                expected = work.get(key, 0)
                if abs(measured - expected) > WORK_TOLERANCE * max(expected, 1):
                    flags.append(f"expected {expected} {key.upper()} per request, measured {measured:.2f}")
        if m.get("errors"):
            flags.append(f"{m['errors']} errors ({m.get('error_rate', 0) * 100:.2f} % of requests)")
        if m.get("loadgen_cpu_util", 0) > SATURATED:
            flags.append("load generator saturated: throughput is a lower bound")
        if m.get("db_cpu_util", 0) > SATURATED:
            flags.append("database saturated: throughput is limited by the database, not only by the service")
        if w.steal is not None and w.steal > self.max_steal:
            flags.append(f"hypervisor steal {w.steal:.1f} % (limit {self.max_steal} %)")
        return m, flags

    def _measured(self, s, run, retries=True):
        """Run `run()` inside a measurement window; repeat while steal time is above the limit."""
        work = bool(s.params.get("work"))
        attempts = 1 + (self.max_retries if retries else 0)
        for attempt in range(1, attempts + 1):
            before = self.db_counts() if work else None
            with self._window() as w:
                r = run()
            delta = None
            if work:
                after = self.db_counts()
                delta = (after[0] - before[0], after[1] - before[1])
            if w.steal is None or w.steal <= self.max_steal or attempt == attempts:
                break
            self.ctx.log(f"  {s.id}: steal {w.steal:.1f} %, repeating ({attempt}/{attempts - 1})")
        m, flags = self._metrics(s, r, w, delta)
        return m, {"attempts": attempt, "flags": flags}

    def measure(self, impl, scenarios, pass_index):
        res = {"scenarios": {}, "quality": {}, "notes": []}
        by_kind = {}
        for s in scenarios:
            by_kind.setdefault(s.kind, []).append(s)
        self.reset_db()
        try:
            startup = by_kind.get("startup", [None])[0]
            runs = int(self.defaults["startup_runs"]) if startup else 1
            times = [self.start_service(impl) for _ in range(runs)]
            if startup:
                time.sleep(2 if self.ctx.quick else 5)
                pss = collectors.pss_kb(self.svc_cg)
                mem = collectors.memory_stat(self.svc_cg) or {}
                image = self.ctx.docker.image(self.image_tag(impl))
                res["scenarios"]["startup"] = {k: v for k, v in {
                    "startup_ms": statistics.median(times), "startup_min_ms": min(times), "startup_max_ms": max(times),
                    "idle_pss_mib": pss / 1024 if pss else None,
                    "idle_anon_mib": mem["anon"] / MIB if mem.get("anon") else None,
                    "image_mb": image["size_bytes"] / 1e6}.items() if v is not None}
                res["quality"]["startup"] = {"runs": times}
            for s in by_kind.get("cold", []):
                m, q = self._measured(s, lambda s=s: self._wrk(s), retries=False)
                self.dirty |= self._writes(s)
                res["scenarios"][s.id], res["quality"][s.id] = m, q
            http = by_kind.get("http", [])
            seen = set()
            for s in http:  # global warm-up, one burst per distinct endpoint
                key = (s.params.get("method", "GET"), s.params["path"])
                if key not in seen:
                    seen.add(key)
                    self._wrk(s, connections=self.defaults["connections"], duration=self.defaults["global_warmup"])
                    self.dirty |= self._writes(s)
            for s in http:
                self._clean_db()  # nobody measures on rows that an earlier workload rewrote
                self._wrk(s, duration=s.params.get("warmup", self.defaults["warmup"]))
                m, q = self._measured(s, lambda s=s: self._wrk(s))
                self.dirty |= self._writes(s)
                res["scenarios"][s.id], res["quality"][s.id] = m, q
            for s in by_kind.get("rate", []):
                self._clean_db()
                rate = s.params["rate"]
                m, q = self._measured(s, lambda s=s: loadgen.oha(
                    self.base + s.params["path"], s.params["rate"], s.params.get("connections", 64),
                    self._duration(s), self.ctx.layout["loadgen"]))
                if m.get("rps", 0) < RATE_REACHED * rate:
                    q["flags"].append(f"could not sustain {rate} req/s (reached {m.get('rps', 0):.0f})")
                self.dirty |= self._writes(s)
                res["scenarios"][s.id], res["quality"][s.id] = m, q
            for s in by_kind.get("soak", []):
                self._clean_db()
                res["scenarios"][s.id], res["quality"][s.id] = self._soak(s)
                self.dirty = True
            for s in by_kind.get("cold", []):
                ref = res["scenarios"].get(s.params.get("compare_to", "db"), {}).get("rps")
                if ref and res["scenarios"][s.id].get("rps"):
                    res["scenarios"][s.id]["warm_ratio"] = res["scenarios"][s.id]["rps"] / ref
            logs = self.ctx.docker.logs(self.svc, 20)
            if any(q.get("flags") for q in res["quality"].values() if isinstance(q, dict)) and logs.strip():
                res["notes"].append("service log tail: " + logs[-1500:])
        finally:
            self.ctx.docker.remove(self.svc)
        return res

    def _soak(self, s):
        p = s.params
        n = 3 if self.ctx.quick else int(p["slices"])
        dur = self.defaults["duration"] if self.ctx.quick else p["slice_duration"]
        p99s, rates, pss, totals = [], [], [], {"requests": 0, "errors": 0}
        t0 = time.monotonic()
        for _ in range(n):
            r = loadgen.oha(self.base + p["path"], p["rate"], p.get("connections", 64), dur, self.ctx.layout["loadgen"])
            p99s.append(r["latency_p99_ms"])
            rates.append(r["rps"] or 0.0)
            totals["requests"] += r["requests"]
            totals["errors"] += r["errors"]
            kb = collectors.pss_kb(self.svc_cg)
            if kb:
                pss.append(((time.monotonic() - t0) / 60, kb / 1024))
        k = max(1, n // 3)
        m = {"latency_p99_ms": statistics.median(p99s), "errors": totals["errors"], "rps": statistics.median(rates),
             "error_rate": totals["errors"] / totals["requests"] if totals["requests"] else 1.0,
             "p99_drift_pct": (statistics.median(p99s[-k:]) / statistics.median(p99s[:k]) - 1) * 100}
        pts = pss[1:] if len(pss) > 2 else pss  # first slice still warms up
        if len(pts) >= 2:
            m["mem_growth_mib_per_min"] = statistics.linear_regression([x for x, _ in pts], [y for _, y in pts]).slope
        flags = [f"{totals['errors']} errors"] if totals["errors"] else []
        if min(rates) < RATE_REACHED * p["rate"]:  # then latency and drift describe queueing, not the service
            flags.append(f"could not sustain {p['rate']} req/s (slowest slice reached {min(rates):.0f})")
        return m, {"slices_p99_ms": p99s, "slices_rps": rates, "flags": flags}
