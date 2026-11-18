# Maintaining the project

For the people who own the GitHub organisation. The repository's workflows and files assume the settings
below; none of them can be made from a pull request.

## One-time setup

- [ ] **Organisation and repository.** Create the organisation and the repository named in the
  `repository` entry of the project config file at the repository root. If you choose other names, rename
  the project first (see [Renaming the project](#renaming-the-project)) so the URLs and `.github/CODEOWNERS`
  match.
- [ ] **Maintainers team.** Create the team `maintainers` in the organisation and give it write access.
  `.github/CODEOWNERS` assigns it the engine (`core/`), every domain's `domain.toml`, `metrics.toml`,
  `harness.py` and `checks.py`, `results/reference-runs.toml`, `.github/` and `tools/`.
- [ ] **Website.** The site is served from the root of `https://<organisation>.github.io`. GitHub only
  does that for a repository named `<organisation>.github.io`, so the workflow
  `.github/workflows/pages.yml` builds the site here and pushes the files there, from the default branch
  only.
  1. Create the public repository `<organisation>.github.io` with a README: the workflow cannot check out
     an empty repository. It keeps `README.md` and `CNAME` there and replaces everything else. In that
     repository choose Settings → Pages → Source: **Deploy from a branch**, default branch, folder `/`.
  2. Create a key pair without a passphrase (`ssh-keygen -t ed25519 -N "" -f site-deploy-key`) and add
     `site-deploy-key.pub` to the site repository as a deploy key **with write access**.
  3. In this repository create the environment `website`, restrict its deployment branches to the default
     branch and add the private key as the environment secret `SITE_DEPLOY_KEY`. Delete both key files.
- [ ] **Private vulnerability reporting.** Settings → Security → enable private vulnerability reporting.
  [SECURITY.md](../SECURITY.md) and the [code of conduct](../CODE_OF_CONDUCT.md) send reports there.
- [ ] **Approval for outside contributors.** Settings → Actions → General → approval for fork pull request
  workflows: require approval for **all** outside contributors. The end-to-end workflow builds contributed
  Dockerfiles and runs the privileged runner on the GitHub runner; a maintainer should read a pull request
  before approving its workflow runs.
- [ ] **Branch protection for the default branch.** Require a pull request, review from code owners and the
  CI checks *Engine, manifests and results* and *Website* (workflow `CI`, runs on every pull request). Do not
  make the end-to-end jobs required: that workflow only runs when `core/`, `domains/` or the CLI change, so a
  required check would block every other pull request.
- [ ] **Public contact address.** Add one to the organisation profile. The code of conduct points people
  there for private conduct reports.
- [ ] **Custom domain (optional).** Set it in the site repository: Settings → Pages → Custom domain. GitHub
  stores it there as the file `CNAME`, which the workflow keeps. Then update `site_url` in the project
  config file: canonical URLs, the sitemap and the published dataset use it.

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
the organisation and repository in URLs and the team in `.github/CODEOWNERS`, so rename the GitHub
organisation and repository to match. Result bundles are left untouched; regenerate the website data with
`publish` afterwards.
