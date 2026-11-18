#!/usr/bin/env python3
"""Regenerate dependency lockfiles of backend implementations inside their own toolchain images.

Run on a machine with Docker after changing a dependency version in a manifest
(go.mod, Cargo.toml, package.json, requirements.in, mix.exs):

    python3 tools/update_lockfiles.py [implementation-id ...]

Commit every file the command changes: `go mod tidy` rewrites go.mod as well as go.sum.
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMPLS = ROOT / "domains" / "backend" / "implementations"

JOBS = {
    "go-nethttp": ("golang:1.27.4-trixie", "go mod tidy"),
    "rust-axum": ("rust:1.100.0-trixie", "cargo generate-lockfile"),
    "node-fastify": ("node:26.13.1-trixie-slim", "npm install --package-lock-only --no-audit --no-fund"),
    "node-express": ("node:26.13.1-trixie-slim", "npm install --package-lock-only --no-audit --no-fund"),
    "python-fastapi": ("python:3.15.2-trixie",
                       "python -m venv /tmp/v && /tmp/v/bin/pip install -q -r requirements.in "
                       "&& /tmp/v/bin/pip freeze --exclude pip > requirements.txt"),
    "elixir-bandit": ("elixir:1.20.5-otp-29", "mix local.hex --force >/dev/null && mix deps.get >/dev/null"),
}


def main(selected):
    for iid, (image, cmd) in JOBS.items():
        if selected and iid not in selected:
            continue
        print(f"{iid}: {cmd}", flush=True)
        uid = f"{os.getuid()}:{os.getgid()}" if hasattr(os, "getuid") else None
        args = ["docker", "run", "--rm", "-v", f"{IMPLS / iid}:/src", "-w", "/src", "-e", "HOME=/tmp"]
        if uid and iid != "elixir-bandit":
            args += ["-u", uid]
        subprocess.run(args + [image, "sh", "-c", cmd], check=True)
        if iid == "elixir-bandit":
            subprocess.run(["docker", "run", "--rm", "-v", f"{IMPLS / iid}:/src", image,
                            "sh", "-c", "rm -rf /src/deps /src/_build"], check=True)


if __name__ == "__main__":
    main(sys.argv[1:])
