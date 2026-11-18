# 3. Privileged runner container and verifiable result bundles

Date: 2026-11-18 · Status: accepted

## Context

Exact per-container CPU time and memory need the host's cgroups and `/proc`. Load generators must be the
same version everywhere. Results from many machines must be trustworthy.

## Decision

- The engine runs inside a runner container with `--privileged`, the host PID and cgroup namespaces and the
  Docker socket. The host needs only Docker and Python; wrk and oha are pinned in the runner image.
- Every container of a run joins the runner's network namespace (loopback only, no host ports, no NAT).
- Results are self-describing bundles: machine fingerprint, CPU layout, versions, image ids, per-pass raw
  values and a summary. CI recomputes the summary from the passes and rejects mismatches and unknown metrics.

## Consequences

- Running benchmarks requires trust in the code being built (documented in SECURITY.md).
- Measurements on Docker Desktop work but are less precise than on Linux.
- A bundle can be audited without rerunning anything; manipulated summaries are detected automatically.
  Manipulated raw values are not, which is why results carry provenance labels: runs whose id maintainers listed in `results/reference-runs.toml` are "reference", all others "community".
