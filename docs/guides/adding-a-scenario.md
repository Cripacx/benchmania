# Adding a scenario

A scenario is one TOML file in `domains/<domain>/scenarios/<id>.toml`. Its `kind` must be one the domain's
harness understands; the harness checks the required parameters (`./benchmania validate`).

## Backend kinds

| Kind | Required | Optional | Behaviour |
|---|---|---|---|
| `http` | `path` | `method`, `body` (file in `loadgen/`), `headers`, `connections`, `duration`, `warmup`, `work` | closed loop with wrk after a warm-up |
| `rate` | `path`, `rate` | `connections`, `duration`, `work` | open loop at a fixed rate with oha, latency corrected |
| `cold` | `path` | `connections`, `duration`, `compare_to`, `work` | like `http` but immediately after start, without warm-up |
| `startup` | – | `path` | repeated container starts, idle memory |
| `soak` | `path`, `rate`, `slices`, `slice_duration` | `connections`, `work` | long fixed-rate run in slices: p99 drift, memory growth |

`work = { select = 1, update = 0 }` declares the database statements per request. The harness measures them
with `pg_stat_statements` and flags results that deviate.

Example:

```toml
id = "db-c64"
title = "Single query, 64 connections"
kind = "http"
order = 95                 # position in tables and charts
description = "GET /db with 64 connections."
path = "/db"
connections = 64
work = { select = 1 }
```

Add `optional = true` for long scenarios that should only run when named with `--scenario`.

A scenario that needs a new endpoint is a breaking change for every implementation: open an issue first,
add the endpoint to `docs/guides/adding-an-implementation.md`, extend `domains/backend/checks.py`, and
implement it everywhere in the same pull request. Bump `methodology_version` in `domain.toml` when results
are no longer comparable with earlier runs.
