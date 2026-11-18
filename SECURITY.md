# Security

## What the runner can do

`./benchmania run` and `./benchmania check` start a **privileged** container with the host PID and cgroup
namespaces and the Docker socket. That is necessary to read exact CPU and memory figures of other
containers. What this means for the code involved:

| Code | Runs as | Access |
|---|---|---|
| The engine (`core/`) and every domain's `harness.py` and `checks.py` | Python inside the privileged runner | root-equivalent on the host |
| Dockerfiles of implementations and environments | `docker build` on the host's daemon | whatever a build can do: network access, CPU, disk |
| Implementation containers | unprivileged containers with all capabilities dropped except binding a port, `no-new-privileges`, a process limit and the declared CPU and memory limits | the runner's loopback network (database and the other containers of the run) and outbound network |

- A pull request that changes the engine or a harness is a change to code that runs as root. These paths
  are protected by `.github/CODEOWNERS`; review them accordingly.
- Only run benchmarks from sources you trust, ideally on a dedicated machine or VM.
- Review the Dockerfiles of implementations before running them; CI builds them on disposable runners.
- Result bundles never contain hostnames, user names or IP addresses. The machine id is a hash of
  hardware facts.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab) instead
of a public issue. We aim to respond within a week.
