# Maintaining the project

For the owner of the GitHub repository. The repository's workflows and files assume the settings below; none
of them can be made from a pull request.

## One-time setup

- [ ] **Repository.** Create the repository named in the `repository` entry of the project config file at
  the repository root. If you choose another name, rename the project first (see
  [Renaming the project](#renaming-the-project)) so the URLs match.
- [ ] **Code owners.** `.github/CODEOWNERS` names who must review the engine (`core/`), every domain's
  `domain.toml`, `metrics.toml`, `harness.py` and `checks.py`, `results/reference-runs.toml`, `.github/` and
  `tools/`. List the maintainers there; they need write access to the repository.
- [ ] **Website.** Settings → Pages → Source: **GitHub Actions**. The workflow `.github/workflows/pages.yml`
  deploys from the default branch only and takes its address from the Pages settings, so the same build
  works under `https://<owner>.github.io/<repository>/` and at the root of a custom domain.
- [ ] **Custom domain.** Create a `CNAME` DNS record for the domain that points to `<owner>.github.io`, enter
  the domain under Settings → Pages → Custom domain and enforce HTTPS once the certificate is issued. Run the
  workflow *Deploy website* again afterwards so the pages are built for the new address. `site_url` in the
  project config file names the same address; the published dataset uses it.
- [ ] **Private vulnerability reporting.** Settings → Security → enable private vulnerability reporting.
  [SECURITY.md](../SECURITY.md) and the [code of conduct](../CODE_OF_CONDUCT.md) send reports there.
- [ ] **Approval for outside contributors.** Settings → Actions → General → approval for fork pull request
  workflows: require approval for **all** outside contributors. The end-to-end workflow builds contributed
  Dockerfiles and runs the privileged runner on the GitHub runner; a maintainer should read a pull request
  before approving its workflow runs.
- [ ] **Ruleset for the default branch.** Settings → Rules → Rulesets: block deletion and force pushes,
  require a linear history, a pull request with one approval and review from code owners, and the CI checks
  *Engine, manifests and results* and *Website* (workflow `CI`, runs on every pull request). Do not make the
  end-to-end jobs required: that workflow only runs when `core/`, `domains/` or the CLI change, so a required
  check would block every other pull request. Let repository admins bypass the ruleset **for pull requests
  only**: a single maintainer can then merge their own change once CI passed, and nobody pushes to the
  default branch directly.
- [ ] **Merging.** Settings → General → Pull Requests: allow squash and rebase merging only (the ruleset
  requires a linear history) and delete head branches after merging.
- [ ] **Actions policy.** Settings → Actions → General: allow only actions created by GitHub (the workflows
  use nothing else) and keep the default workflow permissions read-only.
- [ ] **Security features.** Settings → Security: Dependabot alerts and security updates and secret scanning
  with push protection. Leave the CodeQL *default setup* off: the workflow `.github/workflows/codeql.yml`
  scans the engine, the workflows and the website and skips the benchmark implementations, which default
  setup cannot do.
- [ ] **Discussions and labels.** Enable Discussions; the issue template chooser sends questions and ideas
  there. Create the labels the issue templates set (`bug`, `proposal`, `methodology`); `results`,
  `implementation`, `domain`, `engine` and `website` help sorting pull requests.
- [ ] **Contact address.** Keep a public contact address on the owner's GitHub profile. The code of conduct
  points people there for private conduct reports.

## Recurring tasks

### Reviewing a results pull request

A results pull request adds exactly one bundle file, `results/<domain>/<machine-id>/<run-id>.json`, and
nothing else. CI (`validate`) re-verifies the bundle: the stored summary must match the per-pass data and
every scenario and metric must be known. CI cannot tell whether the numbers are real, so look for
implausible values compared with similar hardware, many quality flags (steal time, saturation) and options
that differ from a full run. Do not merge quick runs (`"quick": true` in the bundle options).

Merged runs are labelled **community**. A run becomes **reference** only when a maintainer who measured it
themselves adds its run id to `results/reference-runs.toml` (below `[machines.<machine-id>]`, with a
`label` and `operator`). Never add a run you did not measure: the machine id is a hash of hardware facts
and does not prove who ran it.

### Bumping pinned versions

- **Implementation dependencies.** Change the version in the implementation's manifest (`go.mod`,
  `Cargo.toml`, `package.json`, `requirements.in`, `mix.exs`), then run
  `python3 tools/update_lockfiles.py <implementation-id>` on a machine with Docker; it regenerates the
  lockfile inside the toolchain image for the implementations it lists. Update the versions in `impl.toml`
  too; they are shown on the website.
- **Base images.** Exact tags, and digests for images without a moving tag policy, are edited by hand in
  the Dockerfiles and `impl.toml`.
- **Runner image.** `core/runner/Dockerfile` pins the Alpine release and `OHA_VERSION`; update the two oha
  checksums together with the version.
- **GitHub Actions and the website.** Dependabot (`.github/dependabot.yml`) opens monthly pull requests for
  the actions used in the workflows and for the npm dependencies in `site/`.

Version changes of measured software usually make old and new results incomparable; raise the domain's
`methodology_version` when that is the case.

### Renaming the project

The name and slug live in the project config file at the repository root. Run
`python3 tools/rename_project.py "NewName"` (add `--slug` to choose the slug, `--dry-run` to preview). It
updates the config, documentation, workflows and the CLI wrapper. It replaces the slug everywhere, including
the repository name in URLs, so rename the GitHub repository to match. Result bundles are left untouched; regenerate the website data with
`publish` afterwards.
