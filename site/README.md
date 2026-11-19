# Website

The public website: a static [Astro](https://astro.build) site with a few [Preact](https://preactjs.com) islands,
generated entirely from the dataset in `src/data/`. Nothing on the site is typed in by hand. Numbers, implementations,
scenarios, metrics, machines and the project's name and links all come from the data.

## Develop

Requires Node 22.23 or newer (CI uses Node 24).

```sh
npm ci              # install exactly what package-lock.json pins
npm run dev         # dev server on http://localhost:4321
npm run check       # astro check (TypeScript in .astro, .ts and .tsx)
npm test            # vitest: formatting, view model, dataset contract, base paths
npm run build       # static output in dist/
npm run verify      # post-build checks on dist/ (run after build, with the same BASE_PATH)
npm run ci          # all four in order
```

To refresh the dataset from the result bundles, run `./benchmania publish` (or `python benchmania publish`) from the
repository root. It writes `site/src/data/index.json` and one `<domain>.json` per domain. Never edit those files by
hand.

### Deployment settings

| Variable | Default | Meaning |
|---|---|---|
| `BASE_PATH` | `/` | Sub-path the site is served from, e.g. `/benchmania/` for a GitHub Pages project site |
| `SITE_URL` | origin of `project.site_url` in `index.json` | Public origin for canonical URLs and the sitemap |

Every internal link and asset goes through `href()` / `joinBase()` in `src/lib/paths.ts`, so the same source works
at a domain root and under a sub-path. `npm run verify` fails if any link escapes the base path. The deployment
workflow (`.github/workflows/pages.yml`) takes both from the repository's Pages settings; CI also builds under a
sub-path.

```sh
BASE_PATH=/benchmania/ npm run build && BASE_PATH=/benchmania/ npm run verify
```

## Data contract (summary)

Schema `benchcore.dataset/v1`, written by `core/benchcore/publish.py`. Types: `src/lib/types.ts`.

`index.json`

- `project`: `name`, `tagline`, `description`, `repository`, `site_url`, `license`, `data_license`. Components read
  the project identity from here. A test fails if the project name or URLs appear in the source.
- `domains[]`: `id`, `title`, `summary`, `status` (`example` domains are not shown), `headline[]`, `default_run`.

`<domain>.json`

- `metrics`: the registry. Each metric has `label`, `unit`, `better` (`higher` | `lower` | `neutral`), `group`,
  `decimals` and `visibility` (`primary` | `secondary` | `diagnostic`).
- `derived`: definitions of derived metrics (e.g. a geometric-mean index), used to explain them.
- `domain.headline[]`: what the site shows first, as `{metric, scenario?, label, hint}`. Without `scenario` the value
  is the derived metric `run.derived[impl][metric]`; with `scenario` it is `run.results[impl][scenario][metric]`.
- `scenarios[]`, `implementations[]`, `machines{}` (`machines[id].reference` is `null` or `{label, operator}`; its
  label is preferred as the machine name).
- `runs[]`: `id`, `created`, `methodology` (`"0"` preliminary, `"1"` current), `provenance` (`reference` |
  `community`), `machine`, `passes`, `options`, `layout`, `flags[]`, `results`, `derived`, `withheld`, `best`.
- `run.best[derived][scenario]` is `{value, by[]}`: for every `geomean_relative` index, the value that counts as 100
  in that scenario and the eligible implementations that measured exactly it. The publisher owns eligibility; the
  site shows these as the winners per workload and never re-derives them. A scenario left out of the index has no entry.
- A flag is `{level, scope, message, pass?, metric?}`; `scope` is `run`, `<impl>` or `<impl>/<scenario>`. A flag
  with `metric` is about that metric only: it attaches to a scenario value of that metric and to a derived value
  computed from it (`derived[].metric`), never to other metrics. Markers follow the most severe flag on a value:
  warnings and errors get the amber alert, info notes alone a quiet muted marker; the leaderboard tags a row
  "flagged" only for an implementation with a warning or error.
- A value is `{m, lo, hi, min, max, n, cv}`: median over `n` passes, 95 % bootstrap interval of the median (`lo`/`hi`,
  null below five passes), min/max, coefficient of variation.

Rules the site follows:

- A metric or scenario without a value reads "not measured in this run", never 0.
- An interval is shown only with at least five passes (`MIN_CI_PASSES` in `src/lib/format.ts`). Older datasets store
  min..max in `lo`/`hi` for fewer passes; that is shown as a range, never as a confidence interval.
- Non-finite numbers never reach a page. `verify` fails on "NaN", "undefined" or "Infinity".

`src/lib/dataset.ts` validates the structure the site depends on at build time (unknown headline metrics, missing
machines, implementation ids that collide with routes) and fails the build with a readable message.

## How pages are generated

| Route | Source | Content |
|---|---|---|
| `/` | `pages/index.astro` | Value proposition, headline leaderboard of the first domain's default run, run context, methodology teaser, entry points |
| `/<domain>/` | `pages/[domain]/index.astro` | Explorer for the default run: scenarios, metrics, chart or table, implementation picker |
| `/<domain>/runs/` and `/<domain>/runs/<run>/` | `pages/[domain]/runs/` | All runs; the explorer and full metadata for every run |
| `/<domain>/<impl>/` | `pages/[domain]/[impl]/index.astro` | Identity, headline numbers with rank, every scenario and measured metric, flags |
| `/<domain>/compare/?ids=a,b` | `pages/[domain]/compare/index.astro` | Side by side with relative differences (selection lives in the query string) |
| `/<domain>/runs/<run>/compare/` and `/<domain>/runs/<run>/<impl>/` | `pages/[domain]/runs/[run]/` | The compare and implementation pages for one specific run (shared bodies in `components/ComparePage.astro` and `ImplementationPage.astro`). Every link on them stays inside the run; a run that is not the default says so and links to the default run (`data-run-exit`, checked by `verify`) |
| `/methodology/`, `/machines/`, `/contribute/`, `/data/`, `/404.html` | `pages/*.astro` | Static pages filled from the data |
| `/data/<file>.json` | `pages/data/[file].ts` | The dataset files, byte for byte, as downloads |
| `/install.sh`, `/install.ps1` | `pages/install.sh.ts`, `pages/install.ps1.ts` | The repository's root installers, read at build time (no copies in `site/`). `verify` checks that `dist/install.sh` and `dist/install.ps1` are byte-identical to them |
| `/install.md` | `pages/install.md.ts` | `docs/install.md`, the install guide for AI coding agents, served verbatim (checked by `verify` like the installers; `verify` also fails if any of the three files mentions a website origin other than `project.site_url`). The home and contribute pages show the three ways to install in `components/InstallChooser.astro`, built from `project.site_url` by `installCommand()` and `installPrompt()` in `src/lib/model.ts`

Layers:

- `src/lib/model.ts`: pure view-model logic (values, ranking, metric selection, flags, relative differences, repository
  links). `valueFlags()` attaches quality flags to a value (for a derived value: the flags of every scenario it is
  computed from, plus implementation-wide ones) and is the only place that decides which flags a value shows. Shared by pages and islands and unit-tested.
- `src/lib/islandProps.ts`: builds the props of the three islands (Leaderboard, Explorer, Compare) at build time.
- `src/lib/view.ts`: compact slices for islands. `encodeIslandProps()` serializes an island's props into one JSON
  string and packs `run` results into id tables plus numeric rows; the island entry points in
  `src/components/islands/Islands.tsx` decode them. Every island is rendered on the server too, so all content is in
  the HTML before JavaScript runs.
- Charts are hand-built (`BarChart.tsx`): thin bars from zero, interval whiskers, direct labels, tooltips on hover and
  keyboard focus, and a table view with the same numbers.

### Progressive disclosure

- Home: only the domain's headline metrics (usually four), then links to everything else.
- Explorer: primary metrics as chips; secondary and diagnostic metrics behind "All metrics"; chart by default, table on
  demand; the run switcher appears only when several runs exist.
- Implementation page: headline tiles first; per scenario the primary metrics, with the rest behind "more metrics".
- Methodology: metric groups beyond the main ones are collapsed.

## Adding a domain

Nothing in the site needs to change. Add the domain to the repository (see `docs/guides/adding-a-domain.md`) with its
metric registry and `headline` list, publish results, and run `./benchmania publish`. The new `<domain>.json` and its
entry in `index.json` create the explorer, runs, implementation and compare pages, the navigation entry and the
methodology sections. The home page features the first domain in `index.json`.

Keep implementation ids clear of the reserved route segments `compare` and `runs`.

## Screenshots

Visual checks are not part of `npm run ci`. Screenshots taken during development go to `.screenshots/` (git-ignored).
