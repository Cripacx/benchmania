# Running on your hardware and submitting results

## Prepare the machine

- Linux with rootful Docker and cgroup v2 (`benchmania doctor` checks both).
- At least 4 physical cores; with 6 or more the layout assigns each role separate CPUs (pinning does not reserve
  them: other work on the machine can still run there). The layout is printed at the start of a run and stored in
  the result.
- Close other workloads. On laptops, use mains power and a fixed performance profile.
- Virtual machines work, but shared hosts add noise: the runner measures hypervisor steal time and repeats
  disturbed measurements. Dedicated or bare-metal machines give the most stable results.

## Install

```sh
curl -fsSL https://benchmania.cleson.dev/install.sh | sh
```

The installer needs git and Python 3.11 or newer and never uses root. It clones the repository into
`~/.local/share/benchmania` and writes the launcher `~/.local/bin/benchmania`; if that directory is not on
your `PATH`, it prints the line to add. The checkout is a normal git checkout: every bundle records the commit
it measured, and you open your pull request from it. Run the installer again to update it (fast-forward only;
it stops if you changed tracked files and never touches your results). [SECURITY.md](../../SECURITY.md#the-installers)
explains how to read the installer first and how to pin a version.

To let an AI coding agent do the installation and the `doctor` check, paste this prompt into it; it points the
agent at [docs/install.md](../install.md), which you can read first:

```text
Install the Benchmania CLI on this machine by following https://benchmania.cleson.dev/install.md.
Then run `benchmania doctor` and tell me whether this machine can run the benchmarks.
```

On Windows, `irm https://benchmania.cleson.dev/install.ps1 | iex` installs the command too, but a Windows
machine cannot measure: use a Linux machine for the steps below (WSL2 with the Linux installer is untested).

If you already work in a clone of the repository, use `./benchmania` from its root instead: everything below
works the same way.

## Run

```sh
benchmania doctor                             # is this machine suitable?
benchmania check backend                      # all implementations must pass
benchmania run backend --label "My workstation"
```

A full run takes several hours: the first reference run (15 implementations, 5 passes) took 5 hours and
7 minutes on a 6-core machine, about 4 minutes per implementation and pass plus 10 minutes of builds. You can
restrict it with `--impl` and `--scenario`, but submitted runs should include all implementations so they
can be compared within the run.

The bundle is written to `results/backend/<machine-id>/<run-id>.json` in the checkout
(`~/.local/share/benchmania` when installed). The last lines of the run print its path, relative to where you
started the run when it is below that directory and absolute otherwise, and the link to this guide.

- Run from an unmodified checkout. The bundle records the commit and whether tracked files were changed, so
  everyone can see which code was measured.
- Start the run where it survives a closed terminal, for example in `tmux` or with
  `nohup benchmania run backend --label "My workstation" > run.log 2>&1 &`.
- A checkpoint of the bundle is written after every implementation. To stop early, press Ctrl-C or send
  `SIGTERM` to the `benchmania` process: the runner saves what it has measured as a bundle with status
  `partial` and removes its containers. `benchmania cleanup` removes containers left behind by a run that
  was killed.

## Check

```sh
benchmania validate
```

Look at the quality flags of your run. Many steal-time or saturation flags mean the machine is not suitable
for publishing. To see your run on the website locally (needs Node.js 22.23 or newer):

```sh
cd ~/.local/share/benchmania
benchmania publish && (cd site && npm ci && npm run dev)
```

## Submit

Open a pull request that adds only your bundle file. Do it from the checkout that holds the bundle; replace
`<machine-id>/<run-id>` with the path the run printed and `<you>` with your GitHub user name.

With the [GitHub CLI](https://cli.github.com) (`gh auth login` once):

```sh
cd ~/.local/share/benchmania
git switch -c results/my-workstation
git add results/backend/<machine-id>/<run-id>.json
git commit -m "Add results: My workstation"
gh repo fork --remote --remote-name fork        # creates your fork and adds it as the remote "fork"
git push -u fork results/my-workstation
gh pr create --repo Cripacx/benchmania --fill
```

Without it: fork the repository on GitHub (the **Fork** button), then

```sh
cd ~/.local/share/benchmania
git switch -c results/my-workstation
git add results/backend/<machine-id>/<run-id>.json
git commit -m "Add results: My workstation"
git remote add fork https://github.com/<you>/benchmania.git
git push -u fork results/my-workstation
```

and open the pull request with the link that `git push` prints, or from your fork's page on GitHub.

- The installed checkout is shallow. If the push is rejected because your fork lacks history, update the fork
  first (**Sync fork** on GitHub) or run `git fetch --unshallow origin` and push again.
- Afterwards, switch back with `git switch main` before you run the installer again: it only updates the
  branch it installed and stops while another branch is checked out. Your results branch stays as it is.

CI verifies that the summary matches the per-pass data and that every metric is known. Maintainers look for
implausible values compared with similar hardware.

Submitted results are labelled **community** on the website. Only runs that maintainers measured themselves
and listed by run id in `results/reference-runs.toml` are labelled **reference**. Bundles contain no hostnames,
user names or IP addresses; the machine id is a hash of hardware facts, shared by every machine of the same
model. By submitting you license the data under CC BY 4.0.
