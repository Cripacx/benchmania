# Running on your hardware and submitting results

## Prepare the machine

- Linux with rootful Docker and cgroup v2 (`./machbench doctor` checks both).
- At least 4 physical cores; 6 or more give each role its own cores. The layout is printed at the start of a
  run and stored in the result.
- Close other workloads. On laptops, use mains power and a fixed performance profile.
- Virtual machines work, but shared hosts add noise: the runner measures hypervisor steal time and repeats
  disturbed measurements. Dedicated or bare-metal machines give the most stable results.

## Run

```sh
./machbench check backend                      # all implementations must pass
./machbench run backend --label "My workstation"
```

A full run takes several hours (roughly 4 minutes per implementation and pass, plus the builds). You can
restrict it with `--impl` and `--scenario`, but submitted runs should include all implementations so they
can be compared within the run. The result is written to `results/backend/<machine-id>/<run-id>.json`.

- Run from a clean checkout of a commit. The bundle records the commit, so everyone can see which code
  was measured.
- Start the run where it survives a closed terminal, for example in `tmux` or with
  `nohup ./machbench run backend > run.log 2>&1 &`.
- A checkpoint of the bundle is written after every implementation. To stop early, press Ctrl-C or send
  `SIGTERM` to the `machbench` process: the runner saves what it has measured as a bundle with status
  `partial` and removes its containers. `./machbench cleanup` removes containers left behind by a run that
  was killed.

## Check

```sh
./machbench validate
./machbench publish && (cd site && npm ci && npm run dev)   # look at your run on the local website
```

Look at the quality flags of your run. Many steal-time or saturation flags mean the machine is not suitable
for publishing.

## Submit

Open a pull request that adds only your bundle file. CI verifies that the summary matches the per-pass data
and that every metric is known. Maintainers look for implausible values compared with similar hardware.

Submitted results are labelled **community** on the website. Only runs that maintainers measured themselves
and listed by run id in `results/reference-runs.toml` are labelled **reference**. Bundles contain no hostnames,
user names or IP addresses; the machine id is a hash of hardware facts, shared by every machine of the same
model. By submitting you license the data under CC BY 4.0.
