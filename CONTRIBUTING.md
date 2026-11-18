# Contributing

Thanks for helping. Benchmarks are only as good as their fairness, so contributions that find problems are
as valuable as new implementations.

## Ways to contribute

| You want to … | Read |
|---|---|
| add a language, framework or variant | [Adding an implementation](docs/guides/adding-an-implementation.md) |
| add a workload | [Adding a scenario](docs/guides/adding-a-scenario.md) |
| open a new area (databases, compute, frontend, …) | [Adding a domain](docs/guides/adding-a-domain.md) |
| measure on your own hardware | [Submitting results](docs/guides/submitting-results.md) |
| improve an existing implementation | open a PR touching only its directory; ping the maintainers listed in its `impl.toml` |
| report unfairness or a measurement error | open a *methodology* issue with evidence |
| improve the engine or the website | open an issue first for larger changes |

## Rules for implementations

1. **Idiomatic and production-like.** Use the framework the way its documentation recommends for
   production. No benchmark-only tricks: no response caching, no precomputed responses, no disabled
   validation, no skipped database work.
2. **Same work.** Every implementation must pass the functional checks (`./machbench check <domain>`).
   The backend harness also counts database statements per request; a mismatch is flagged in the results.
3. **Pinned versions.** Exact image tags, exact dependency versions and committed lockfiles. Declare the
   versions in `impl.toml`.
4. **Use the resources.** Configure worker counts for the 2-CPU limit (and say so in `notes`).
5. **Category honesty.** Results are shown with the category so readers compare like with like:
   - `bare`: standard library or runtime built-ins only, no web framework (net/http, Bun.serve, plain PHP),
   - `micro`: a small routing library (Express, Fastify, axum, Plug, ASP.NET minimal APIs),
   - `framework`: a batteries-included web framework (FastAPI),
   - `fullstack`: a full application framework (Spring Boot).

   Domains that time programs rather than servers (such as `_example`) use `tool`.

## Workflow

1. Fork, create a branch, make the change.
2. Run `python -m pytest tests`, `./machbench validate` and, for implementation changes,
   `./machbench check <domain> --impl <id>` and a short `./machbench run <domain> --impl <id> --quick --passes 1`.
3. Open a pull request. CI runs unit tests, validates manifests and result bundles, builds the website and
   runs an end-to-end smoke test of changed implementations.
4. Published numbers come from dedicated hardware runs, never from CI machines.

## Submitting results

A results pull request adds only the bundle file (`results/<domain>/<machine-id>/<run-id>.json`): no changes
to code, manifests, `results/reference-runs.toml` or the generated website data. See
[Submitting results](docs/guides/submitting-results.md) for how to run and check it.

## Development setup

```sh
python -m pip install pytest
python -m pytest tests          # engine tests (no Docker needed)
./machbench validate            # manifests and bundles
./machbench publish && cd site && npm ci && npm run dev   # website with the current dataset
```

`./machbench publish` writes `site/src/data/*.json`. These files are generated (they contain a timestamp) and
ignored by git; never commit them.

Everything in this repository — code, comments, documentation, commit messages — is written in English.
By contributing you agree that your contributions are licensed under the MIT license (code) and CC BY 4.0
(result data). Please follow the [code of conduct](CODE_OF_CONDUCT.md). Maintainers find the one-time setup and recurring
tasks in [docs/maintaining.md](docs/maintaining.md).
