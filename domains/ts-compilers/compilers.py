"""Pure logic of the ts-compilers domain: workload manifests, compiler commands and diagnostics.

No Docker and no measurement here, so that all of it is unit tested (tests/test_ts_compilers.py).

A diagnostic is identified by file, line, column, category and code, written the way `tsc --pretty false`
prints it without the message: `src/a.ts(3,7): error TS2322`, or `error TS5107` for one without a location.
Messages are not compared: their wording is not part of what a compiler has to agree on.
"""

import re
import tomllib
from collections import Counter
from pathlib import Path

MODES = ("check", "single", "emit")
PLACEHOLDERS = ("{tsconfig}", "{out}")
DIAGNOSTIC_RE = re.compile(r"^(?:(?P<file>.+?)\((?P<line>\d+),(?P<col>\d+)\): )?"
                           r"(?P<cat>error|warning|message) TS(?P<code>\d+)(?:: (?P<msg>.*))?$")


# --- diagnostics -------------------------------------------------------------------------------------------
def diagnostic_key(m):
    loc = f"{m['file']}({m['line']},{m['col']}): " if m["file"] is not None else ""
    return f"{loc}{m['cat']} TS{m['code']}"


def parse_diagnostics(text):
    """Diagnostic keys in the order printed. Indented lines continue the previous message and are skipped,
    as is everything else that is not a diagnostic (a tool's banner, a crash message)."""
    keys = []
    for line in text.splitlines():
        if not line or line[0].isspace():
            continue
        m = DIAGNOSTIC_RE.match(line.rstrip("\r"))
        if m:
            keys.append(diagnostic_key(m))
    return keys


def normalize(entry):
    """An expected diagnostic as written in a manifest, in canonical form; ValueError if it is not one."""
    m = DIAGNOSTIC_RE.match(entry.strip())
    if not m or m["msg"] is not None:
        raise ValueError(f"not a diagnostic of the form 'file(line,col): error TS1234': {entry!r}")
    return diagnostic_key(m)


def compare(expected, actual):
    """Problems (empty = same diagnostics, each as often as expected). Order does not matter: parallel
    checkers may report files in a different order."""
    want, got = Counter(normalize(e) for e in expected), Counter(actual)
    problems = []
    unexpected = list((got - want).elements())
    missing = list((want - got).elements())
    if unexpected:
        problems.append(f"{len(unexpected)} unexpected diagnostic(s): " + "; ".join(unexpected[:5]))
    if missing:
        problems.append(f"{len(missing)} expected diagnostic(s) missing: " + "; ".join(missing[:5]))
    return problems


def run_problems(run, expected, expect_files=None):
    """Why one run is not a valid measurement (empty = valid).

    Diagnostics decide, not exit codes (tsc 7.0 exits 1 where the others exit 2 for the same error), but the
    exit code must agree with them: 0 when no diagnostics are expected, non-zero otherwise. A non-zero exit
    without the expected diagnostics (a crash, out of memory) is never valid.
    """
    code = run["exit"]
    if code < 0:
        return [f"killed by signal {-code}"]
    problems = compare(expected, parse_diagnostics(run["output"]))
    if not expected and code != 0:
        problems.append(f"exit code {code} where 0 was expected")
    if expected and code == 0:
        problems.append("exit code 0 although errors were expected")
    for suffix, n in (expect_files or {}).items():
        got = run.get("files", {}).get(suffix)
        if got != n:
            problems.append(f"emitted {got} '{suffix}' files, expected {n}")
    if problems and run["output"].strip():
        problems.append("output ends with: " + run["output"].strip()[-300:])
    return problems


# --- commands ----------------------------------------------------------------------------------------------
def command(compiler, mode, tsconfig, out):
    """argv of one mode: the common command followed by the mode's arguments, placeholders filled in."""
    args = list(compiler["command"]) + list(compiler["modes"][mode])
    return [a.replace("{tsconfig}", tsconfig).replace("{out}", out) for a in args]


def compiler_problems(data, workloads):
    """Static checks of an implementation's [compiler] table against the workloads."""
    c = data.get("compiler")
    if not isinstance(c, dict):
        return ["impl.toml needs a [compiler] table (package, typescript, command, modes)"]
    problems = []
    package = c.get("package")
    if not isinstance(package, str) or not package:
        problems.append("[compiler] package must name the npm package")
    elif not isinstance(data.get("versions", {}).get(package), str):
        problems.append(f"[versions] must give the exact version of '{package}' (it is what the image installs)")
    line = c.get("typescript")
    if not isinstance(line, str) or not re.fullmatch(r"\d+\.\d+", line):
        problems.append("[compiler] typescript must be the TypeScript line it implements, like \"7.1\"")
    if not _strings(c.get("command")):
        problems.append("[compiler] command must be a non-empty list of strings")
    modes = c.get("modes", {})
    for mode in MODES:
        if not isinstance(modes.get(mode), list) or not all(isinstance(a, str) for a in modes.get(mode, [None])):
            problems.append(f"[compiler.modes] {mode} must be a list of strings")
    for mode in modes:
        if mode not in MODES:
            problems.append(f"[compiler.modes] unknown mode '{mode}' (known: {', '.join(MODES)})")
    env = c.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        problems.append("[compiler] env must map names to strings")
    args = (c.get("command") or []) + [a for m in modes.values() if isinstance(m, list) for a in m]
    for a in args:
        if isinstance(a, str):
            for ph in re.findall(r"\{[^}]*\}", a):
                if ph not in PLACEHOLDERS:
                    problems.append(f"[compiler] unknown placeholder {ph} (known: {', '.join(PLACEHOLDERS)})")
    if isinstance(line, str):
        for wid, w in workloads.items():
            if line not in w.get("expected", {}):
                problems.append(f"workload '{wid}' declares no expected diagnostics for TypeScript {line}")
    return problems


def _strings(v):
    return isinstance(v, list) and v and all(isinstance(a, str) and a for a in v)


# --- workloads and scenarios -------------------------------------------------------------------------------
WORKLOAD_KEYS = ("title", "repository", "commit", "project", "tsconfig")


def load_workloads(directory):
    """{id: manifest} for every workloads/<id>/workload.toml."""
    out = {}
    for p in sorted(Path(directory).glob("*/workload.toml")):
        with open(p, "rb") as f:
            out[p.parent.name] = {**tomllib.load(f), "id": p.parent.name, "path": p.parent}
    return out


def workload_problems(w):
    where = f"workloads/{w['id']}/workload.toml"
    problems = [f"{where}: missing '{k}'" for k in WORKLOAD_KEYS if not isinstance(w.get(k), str) or not w[k]]
    if isinstance(w.get("commit"), str) and not re.fullmatch(r"[0-9a-f]{40}", w["commit"]):
        problems.append(f"{where}: commit must be a full 40-character commit id")
    if not (w["path"] / "prepare.sh").is_file():
        problems.append(f"{where}: prepare.sh not found next to it")
    expected = w.get("expected")
    if not isinstance(expected, dict) or not expected:
        problems.append(f"{where}: [expected] must list the diagnostics of each TypeScript line (\"7.1\" = [])")
    else:
        for line, diags in expected.items():
            if not isinstance(diags, list):
                problems.append(f"{where}: expected \"{line}\" must be a list")
                continue
            for d in diags:
                try:
                    normalize(d)
                except (ValueError, AttributeError) as e:
                    problems.append(f"{where}: expected \"{line}\": {e}")
    seed = w.get("seeded_error")
    if not isinstance(seed, dict) or not all(isinstance(seed.get(k), str) for k in ("file", "append", "expect")):
        problems.append(f"{where}: [seeded_error] needs file, append and expect")
    else:
        try:
            normalize(seed["expect"])
        except ValueError as e:
            problems.append(f"{where}: seeded_error.expect: {e}")
    return problems


def scenario_problems(params, workloads):
    problems = []
    if params.get("workload") not in workloads:
        problems.append(f"unknown workload '{params.get('workload')}' (known: {', '.join(sorted(workloads))})")
    if params.get("mode") not in MODES:
        problems.append(f"mode must be one of {', '.join(MODES)}")
    cpus = params.get("cpus")
    if cpus is not None and (not isinstance(cpus, int) or cpus < 1):
        problems.append("cpus must be a positive whole number")
    files = params.get("expect_files")
    if files is not None and (params.get("mode") != "emit" or not isinstance(files, dict)
                              or not all(isinstance(v, int) for v in files.values())):
        problems.append("expect_files is a table of file suffix = count, for emit scenarios only")
    return problems
