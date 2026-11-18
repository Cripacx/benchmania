## What and why

<!-- One or two sentences: the problem this solves or what it adds. -->

## Checklist

- [ ] `python -m pytest tests` and `./benchmania validate` pass
- [ ] New or changed implementations: `./benchmania check <domain> --impl <id>` passes, versions are pinned, `impl.toml` is complete
- [ ] New scenarios or metrics: documented in the guide or registry; `methodology_version` bumped if results are no longer comparable
- [ ] Result bundles: produced by an unmodified run (`--quick` runs are not accepted)
