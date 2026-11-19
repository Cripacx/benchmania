# Install Benchmania

This page is written for an AI coding agent that installs Benchmania for a person; it reads the same for the
person. Follow the steps in order and report back as described at the end.

Benchmania is a community benchmark suite: it measures many implementations of the same task (for example
web backends in different languages) under controlled conditions on Linux with Docker. The `benchmania`
command lists, checks and measures them, and the website <https://benchmania.cleson.dev> publishes the results.

## Rules for the agent

- No `sudo`, no administrator rights. The installers need neither; if something requires them (installing
  git, Python or Docker), tell the person what is missing and stop.
- Do not edit shell start-up files (`~/.profile`, `~/.bashrc`, `~/.zshrc`, a PowerShell profile) without
  asking. If the command is not on `PATH`, show the person the line the installer printed instead.
- Do not start a benchmark (`benchmania run`, `benchmania check`) unless the person asked for one: it builds
  Docker images and starts a privileged container, and a full run takes several hours. Installing and
  `benchmania doctor` do none of that.
- Do not edit, commit or delete files in the checkout the installer creates.

## 1. Pick the installer

Linux, macOS and Windows Subsystem for Linux (WSL), in a POSIX shell:

```sh
curl -fsSL https://benchmania.cleson.dev/install.sh | sh
```

Windows, in PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
irm https://benchmania.cleson.dev/install.ps1 | iex
```

Both need git and Python 3.11 or newer, and both can be read first: they are the files
[`install.sh`](https://github.com/Cripacx/benchmania/blob/main/install.sh) and
[`install.ps1`](https://github.com/Cripacx/benchmania/blob/main/install.ps1) in the repository.
They clone the repository (a normal git checkout) and write one launcher:

| | Checkout | Launcher |
| --- | --- | --- |
| Linux, macOS, WSL | `~/.local/share/benchmania` | `~/.local/bin/benchmania` |
| Windows | `%LOCALAPPDATA%\benchmania` | `%USERPROFILE%\.local\bin\benchmania.cmd` |

The Linux installer never edits start-up files; it prints the `export PATH=...` line to add if
`~/.local/bin` is not on `PATH`. The Windows installer adds its directory to the user `Path` (set
`BENCHMANIA_NO_MODIFY_PATH=1` before running it to prevent that). Running an installer again updates the
checkout. If the installer stops with `error:`, read the lines below it and see Troubleshooting.

## 2. Verify

```sh
benchmania --version
```

It prints `Benchmania engine <version>`. If the command is not found, the launcher's directory is not on
`PATH` in this shell yet: call the launcher by the full path the installer printed after `Command:`, for
example `~/.local/bin/benchmania --version` (Linux, macOS) or `& "$env:USERPROFILE\.local\bin\benchmania.cmd" --version`
(Windows). Use that full path for the remaining steps.

## 3. Check the machine

```sh
benchmania doctor
```

How to read it:

- Exit code 0 and `docker: ok ...`, `cgroup: v2 ...` and `rootless: no`: this machine can measure, provided
  Docker runs on this machine. `doctor` does not notice a remote engine (selected with `DOCKER_HOST` or a
  Docker context); with one, measuring does not work.
- `docker: NOT reachable`: Docker is missing, not running, or this user may not use it. Measuring is not
  possible until that is fixed; `list`, `validate`, `scaffold` and `publish` work without it.
- `cgroup: v1 ... <- cgroup v2 required`: the Linux system uses cgroup v1; measuring needs cgroup v2.
- `rootless: yes`: Docker runs rootless; measurements need rootful Docker.
- `warning: not enough physical cores ...` or `fewer CPUs than roles ...`: it can run, but the results are
  noisy. Submitted measurements need at least 4 physical cores.
- `system: Windows <- measuring needs Linux` (or `Darwin` on macOS): the command works here, but this machine
  cannot measure, also when Docker Desktop is running. WSL2 is a Linux environment, but measuring there is
  untested.

## 4. Only if the person asked for a run: a smoke run

Skip this step unless the person asked you to try a run. If `doctor` says the machine can measure, this quick
run builds the runner image and the two example implementations, starts the privileged runner container and
takes a few minutes. It adds one result file below `results/` in the checkout, marked as a smoke test and
never published.

```sh
benchmania run example --quick --passes 1
```

## 5. Tell the person

- Where it is installed: the checkout directory and the launcher path (the `Benchmania installed:` or
  `Benchmania updated:` and `Command:` lines of the installer output) and which commit (shown there in
  parentheses, or `git -C <checkout> rev-parse --short HEAD`).
- Whether `benchmania` is on `PATH`; if not, the line to add, as printed by the installer.
- Whether this machine can measure, in one sentence, with the reason from `doctor`.
- The next command, for the person to start or to ask you for. On a machine that can measure: the smoke run
  of step 4 (a few minutes), then `benchmania check backend` and
  `benchmania run backend --label "My workstation"` for a full run (several hours; start it in `tmux` or with
  `nohup`). Otherwise: `benchmania list` to see the domains, scenarios and implementations.

## Troubleshooting

- **git is required but was not found**: install git (Linux: the package manager; macOS:
  `xcode-select --install`; Windows: `winget install Git.Git`), open a new terminal, run the installer again.
- **Python 3.11 or newer is required**: install a newer Python from <https://www.python.org/downloads/> or the
  package manager. On Linux and macOS `python3` must point to it; on Windows `py -3`, `python` or `python3`
  must run it (the Microsoft Store placeholder `python.exe` does not count).
- **`benchmania: command not found` after the install**: open a new terminal, or add the printed `PATH` line
  (Linux, macOS), or use the full launcher path from step 2.
- **`benchmania` stops working after Python was replaced or removed**: on Windows the launcher calls the
  Python found at install time, on Linux and macOS `python3` from `PATH`. Run the installer again.
- **Docker missing or not reachable**: measuring needs rootful Docker with cgroup v2 on Linux
  (<https://docs.docker.com/engine/install/>). Installing it needs administrator rights, so leave it to the person.
- **Windows**: the command can list, validate, scaffold and publish; measuring needs Linux with Docker. To
  measure on a Windows machine, use WSL2 with the Linux installer (untested) or a Linux machine.
- **The installer refuses to update** (modified tracked files, another branch checked out, a foreign
  launcher file): it explains why and what to do. Report that to the person; do not force it.

## More

- Submitting a measurement: <https://github.com/Cripacx/benchmania/blob/main/docs/guides/submitting-results.md>
- Repository: <https://github.com/Cripacx/benchmania>
