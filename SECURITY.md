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

## The installers

### Linux, macOS and WSL

`curl -fsSL https://benchmania.cleson.dev/install.sh | sh` runs [`install.sh`](install.sh) from this
repository; the website serves the same file, byte for byte. It needs no root and never calls `sudo`. It
checks for git and Python 3.11 or newer, clones the repository into `~/.local/share/benchmania` (or
`BENCHMANIA_HOME`) and writes one small launcher script, `~/.local/bin/benchmania` (or in `BENCHMANIA_BIN`).
It writes nothing else: no shell start-up files, no system directories. Running it again updates the checkout
by fast-forward only; it stops if tracked files were modified, if a file of yours (untracked or ignored) is in
the way of a new one, if the directory is a checkout of another repository, or if the launcher path holds a
file it did not write.

To read it before running it:

```sh
curl -fsSL https://benchmania.cleson.dev/install.sh -o install.sh
less install.sh
sh install.sh
```

To install a specific version instead of the default branch, pin a tag (or branch) with `BENCHMANIA_REF`;
replace `TAG` with its name:

```sh
curl -fsSL https://benchmania.cleson.dev/install.sh | BENCHMANIA_REF='TAG' sh
```

### Windows

`irm https://benchmania.cleson.dev/install.ps1 | iex` runs [`install.ps1`](install.ps1) from this repository,
served byte for byte like `install.sh`, in your PowerShell session. It needs no administrator rights. It checks
for git and Python 3.11 or newer (the Microsoft Store placeholder `python.exe` does not count), clones the
repository into `%LOCALAPPDATA%\benchmania` (or `BENCHMANIA_HOME`) and writes one launcher,
`%USERPROFILE%\.local\bin\benchmania.cmd` (or in `BENCHMANIA_BIN`). It updates and refuses exactly like
`install.sh`. It runs as a single script block: a truncated download does not parse and runs nothing, and it
never calls `exit` in your session or leaves functions or variables behind.

It changes one setting: unless that directory is already on your `Path` or `BENCHMANIA_NO_MODIFY_PATH=1` is set,
it appends the directory to your **user** `Path` (`HKCU\Environment`, keeping the value type and any
`%VARIABLES%` in it) and to the current session, and says so. It never writes the machine `Path`. To uninstall,
remove the checkout, the launcher and that `Path` entry.

To read it before running it:

```powershell
irm https://benchmania.cleson.dev/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1
```

To pin a version, set `$env:BENCHMANIA_REF = 'TAG'` (the tag's or branch's name) before running it.

### Installing through an AI coding agent

The prompt on the website (`Install the Benchmania CLI on this machine by following
https://benchmania.cleson.dev/install.md. ...`) gives the agent no commands of its own. It only points the
agent at [`docs/install.md`](docs/install.md), served byte for byte, which you can read first. That document
tells the agent to use one of the two installers above, to use no `sudo` or administrator rights, not to edit
shell start-up files without asking and not to start a benchmark unless you asked for one. An agent can still
deviate from it, so watch what it runs as you would for any other task.

Keep in mind what you install: `benchmania run` and `check` start the privileged runner described above.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a vulnerability" on the Security tab) instead
of a public issue. We aim to respond within a week.
