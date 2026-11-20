/**
 * Pure view-model logic on top of the dataset: runs, values, ranking, metric selection, flags,
 * relative differences and repository links. No I/O here, so everything is unit-testable and can be
 * shared by server-rendered pages and client islands.
 */
import { formatNumber, hasInterval, isNum, MINUS, UNIT_SPACE } from './format';
import type {
  Better,
  DeclaredComparison,
  DerivedDefinition,
  DomainData,
  Flag,
  HeadlineEntry,
  Implementation,
  Machine,
  Metric,
  Project,
  Run,
  Scenario,
  Stat,
  Value,
  Visibility,
} from './types';

/* ----------------------------------------------------------------------------------------------
 * Runs and implementations
 * -------------------------------------------------------------------------------------------- */

export function sortScenarios(scenarios: Scenario[]): Scenario[] {
  return [...scenarios].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

export function getRun(domain: DomainData, id: string | null | undefined): Run | undefined {
  if (!id) return undefined;
  return domain.runs.find((r) => r.id === id);
}

/** The run the engine selected as default; falls back to the first complete run, then the first run. */
export function defaultRun(domain: DomainData): Run | undefined {
  return (
    getRun(domain, domain.default_run) ??
    domain.runs.find((r) => r.status === 'complete') ??
    domain.runs[0]
  );
}

/**
 * Canonical route scope for a link that picks a run from a list ("other runs"): null for the default run (short
 * URLs), else the run id. Pages do not use this for their own links: those follow the page's route, so every
 * page under /<domain>/runs/<run>/ links inside that run, also when it is the default run.
 */
export function runScope(domain: DomainData, run: Pick<Run, 'id'>): string | null {
  return run.id === defaultRun(domain)?.id ? null : run.id;
}

/** Every implementation id that gets a page: the domain's implementations plus ids found only in runs. */
export function implementationPageIds(domain: DomainData): string[] {
  const ids = new Set([...domain.implementations.map((i) => i.id), ...domain.runs.flatMap((r) => Object.keys(r.results ?? {}))]);
  return [...ids];
}

/** Implementation ids that have data in a run, in the domain's declaration order. */
export function runImplementationIds(domain: Pick<DomainData, 'implementations'>, run: Pick<Run, 'results' | 'implementations'>): string[] {
  const inRun = new Set([...Object.keys(run.results ?? {}), ...Object.keys(run.implementations ?? {})]);
  const ordered = domain.implementations.map((i) => i.id).filter((id) => inRun.has(id));
  for (const id of inRun) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/**
 * The implementation's identity. The domain manifest is current; the run carries the manifest as it
 * was measured. Identity fields come from the domain, falling back to the run snapshot for
 * implementations that were removed since.
 */
export function implementation(domain: DomainData, id: string, run?: Run): Implementation {
  const current = domain.implementations.find((i) => i.id === id);
  if (current) return current;
  const snap = run?.implementations?.[id]?.manifest ?? {};
  return {
    ...snap,
    id,
    name: typeof snap.name === 'string' ? snap.name : id,
    language: typeof snap.language === 'string' ? snap.language : 'Unknown',
    category: typeof snap.category === 'string' ? snap.category : 'unknown',
  };
}

/** Versions as recorded in the run (what was measured), else the current manifest's versions. */
export function measuredVersions(domain: DomainData, id: string, run?: Run): Record<string, string> {
  const snap = run?.implementations?.[id]?.manifest?.versions;
  if (snap && Object.keys(snap).length) return snap as Record<string, string>;
  return implementation(domain, id, run).versions ?? {};
}

/** "Language · Framework · Variant": the one way a name and its variant read as text. */
export function implLabel(impl: { name: string; variant?: string | null }): string {
  return impl.variant ? `${impl.name} · ${impl.variant}` : impl.name;
}

/** Implementation fields every page already shows; anything else in a manifest is domain-specific. */
const KNOWN_IMPL_KEYS = new Set([
  'id', 'name', 'language', 'category', 'runtime', 'framework', 'variant', 'description', 'notes', 'maintainers',
  'versions', 'versions_note', 'source',
]);

export interface DetailRow {
  label: string;
  /** `code` for commands and argument lists, `link` for URLs. */
  kind: 'text' | 'code' | 'link';
  value: string;
  /** For a command mode: the scenarios that run it. */
  scenarios?: string[];
}

export interface ManifestDetail {
  key: string;
  title: string;
  rows: DetailRow[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Domain-specific tables of an implementation manifest (e.g. how a compiler is invoked), as rows a page can show
 * without knowing the domain. Taken from the manifest the run recorded when there is one (what was measured), else
 * the current one. A table with a `command` list and `modes` of argument lists reads as one full command per mode,
 * labelled with the scenarios whose `params.mode` names it; empty values are left out.
 */
export function manifestDetails(domain: Pick<DomainData, 'implementations' | 'scenarios'>, id: string, run?: Run): ManifestDetail[] {
  const snap = run?.implementations?.[id]?.manifest;
  const source: Record<string, unknown> = isPlainObject(snap) && Object.keys(snap).length ? snap : (domain.implementations.find((i) => i.id === id) ?? {});
  const out: ManifestDetail[] = [];
  for (const [key, table] of Object.entries(source)) {
    if (KNOWN_IMPL_KEYS.has(key) || !isPlainObject(table)) continue;
    const rows: DetailRow[] = [];
    const command = isStringList(table.command) ? table.command : null;
    const modes = command && isPlainObject(table.modes) ? table.modes : null;
    const push = (label: string, v: unknown) => {
      if (typeof v === 'string' && v) rows.push({ label, kind: /^https?:\/\//.test(v) ? 'link' : 'text', value: v });
      else if (typeof v === 'number' || typeof v === 'boolean') rows.push({ label, kind: 'text', value: String(v) });
      else if (isStringList(v) && v.length) rows.push({ label, kind: 'code', value: v.join(' ') });
      else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) push(`${label} ${k.replace(/_/g, ' ')}`, x);
    };
    for (const [k, v] of Object.entries(table)) {
      if (modes && (k === 'command' || k === 'modes')) continue;
      push(k.replace(/_/g, ' '), v);
    }
    if (command && modes) {
      for (const [mode, args] of Object.entries(modes)) {
        if (!isStringList(args)) continue;
        const scenarios = domain.scenarios.filter((s) => (s.params as Record<string, unknown> | undefined)?.mode === mode).map((s) => s.title);
        rows.push({ label: mode.replace(/_/g, ' '), kind: 'code', value: [...command, ...args].join(' '), scenarios });
      }
    } else if (command) rows.push({ label: 'command', kind: 'code', value: command.join(' ') });
    if (rows.length) out.push({ key, title: capitalize(key.replace(/_/g, ' ')), rows });
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------
 * Values
 * -------------------------------------------------------------------------------------------- */

function isStat(v: unknown): v is Stat {
  return !!v && typeof v === 'object' && isNum((v as Stat).m);
}

/**
 * The value of one metric for one implementation. `scenario` null/undefined means a derived metric
 * from `run.derived`. Returns null when the run has no (finite) value.
 */
export function metricValue(run: Pick<Run, 'results' | 'derived'>, scenario: string | null | undefined, metric: string, impl: string): Value | null {
  if (!scenario) {
    const v = run.derived?.[impl]?.[metric];
    return isNum(v) ? { m: v, derived: true } : null;
  }
  const s = run.results?.[impl]?.[scenario]?.[metric];
  return isStat(s) ? s : null;
}

export function headlineValue(run: Pick<Run, 'results' | 'derived'>, entry: HeadlineEntry, impl: string): Value | null {
  return metricValue(run, entry.scenario ?? null, entry.metric, impl);
}

/** Orders numbers best-first for a metric direction; neutral metrics sort high-to-low. */
export function compareBest(a: number | null | undefined, b: number | null | undefined, better: Better): number {
  const av = isNum(a);
  const bv = isNum(b);
  if (!av && !bv) return 0;
  if (!av) return 1; // missing values always last
  if (!bv) return -1;
  return better === 'lower' ? a - b : b - a;
}

/**
 * Standard competition ranking ("1224"): equal values share a rank. Neutral metrics are not ranked.
 * Missing values get no rank.
 */
export function rankMap(entries: Array<{ id: string; value: number | null | undefined }>, better: Better): Map<string, number> {
  const ranks = new Map<string, number>();
  if (better === 'neutral') return ranks;
  const valid = entries.filter((e): e is { id: string; value: number } => isNum(e.value));
  for (const e of valid) {
    const ahead = valid.filter((o) => (better === 'higher' ? o.value > e.value : o.value < e.value)).length;
    ranks.set(e.id, ahead + 1);
  }
  return ranks;
}

export interface HeadlineLeader {
  metric: Metric;
  /** The value of the leaders (all share it), or null when nobody is ranked. */
  best: Value | null;
  /** Implementations ranked first (ties: several), in run order. */
  winners: string[];
  /** How many implementations of the run have a value for this entry. */
  measured: number;
}

/** Who leads one headline entry in a run: the implementations ranked first and their value. */
export function headlineLeader(domain: Pick<DomainData, 'metrics' | 'implementations'>, run: Run, entry: HeadlineEntry): HeadlineLeader {
  const metric = metricOrFallback(domain.metrics, entry.metric);
  const ids = runImplementationIds(domain, run);
  const values = ids.map((id) => ({ id, value: headlineValue(run, entry, id)?.m ?? null }));
  const ranks = rankMap(values, metric.better);
  const winners = ids.filter((id) => ranks.get(id) === 1);
  return {
    metric,
    best: winners[0] ? headlineValue(run, entry, winners[0]) : null,
    winners,
    measured: values.filter((v) => v.value !== null).length,
  };
}

/** Ids sorted best-first by a value accessor; ties keep the input order. */
export function sortIdsBy(ids: string[], value: (id: string) => number | null | undefined, better: Better): string[] {
  return ids
    .map((id, index) => ({ id, index, v: value(id) }))
    .sort((a, b) => compareBest(a.v, b.v, better) || a.index - b.index)
    .map((e) => e.id);
}

/* ----------------------------------------------------------------------------------------------
 * Metrics
 * -------------------------------------------------------------------------------------------- */

export const VISIBILITY_ORDER: Visibility[] = ['primary', 'secondary', 'diagnostic'];

export function visibilityOf(metric: Metric | undefined): Visibility {
  const v = metric?.visibility;
  return v === 'primary' || v === 'diagnostic' ? v : 'secondary';
}

/** Fallback registry entry for a metric id that the registry does not know. */
export function metricOrFallback(metrics: Record<string, Metric>, id: string): Metric {
  return (
    metrics[id] ?? {
      id,
      label: id,
      unit: '',
      better: 'neutral',
      group: 'other',
      description: '',
      decimals: 2,
      visibility: 'diagnostic',
    }
  );
}

type MetricRegistry = Record<string, Metric>;
type RunValues = Pick<Run, 'results' | 'derived'> & Partial<Pick<Run, 'withheld'>>;

/**
 * Metric ids with at least one value in a scenario of a run (null scenario = derived), registry order. A derived
 * metric that the publisher withheld counts as well (for everybody, in the worst case): it is shown with its
 * reason, never dropped as if it had not been measured.
 */
export function measuredMetricIds(metrics: MetricRegistry, run: RunValues, scenario: string | null): string[] {
  const found = new Set<string>();
  if (!scenario) {
    for (const values of Object.values(run.derived ?? {}))
      for (const [k, v] of Object.entries(values ?? {})) if (isNum(v)) found.add(k);
    for (const reasons of Object.values(run.withheld ?? {}))
      for (const [k, why] of Object.entries(reasons ?? {})) if (typeof why === 'string' && why) found.add(k);
  } else {
    for (const scen of Object.values(run.results ?? {}))
      for (const [k, v] of Object.entries(scen?.[scenario] ?? {})) if (isStat(v)) found.add(k);
  }
  const registry = Object.keys(metrics);
  const ordered = registry.filter((id) => found.has(id));
  for (const id of [...found].sort()) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** Splits metric ids by registry visibility, keeping order. */
export function byVisibility(metrics: MetricRegistry, ids: string[]): Record<Visibility, string[]> {
  const out: Record<Visibility, string[]> = { primary: [], secondary: [], diagnostic: [] };
  for (const id of ids) out[visibilityOf(metrics[id])].push(id);
  return out;
}

/** Every metric id that has a value anywhere in the run (results or derived), or a derived value withheld with a reason. */
export function metricIdsInRun(run: RunValues): Set<string> {
  const ids = new Set<string>(measuredMetricIds({}, run, null));
  for (const scen of Object.values(run.results ?? {}))
    for (const metrics of Object.values(scen ?? {})) for (const [k, v] of Object.entries(metrics ?? {})) if (isStat(v)) ids.add(k);
  return ids;
}

/** Registry metrics (default: primary ones) that have no value at all in this run. */
export function unmeasuredMetrics(domain: DomainData, run: Run, visibility: Visibility[] = ['primary']): Metric[] {
  const present = metricIdsInRun(run);
  return Object.values(domain.metrics).filter((m) => visibility.includes(visibilityOf(m)) && !present.has(m.id));
}

/** Scenarios of the domain that have no data in this run. */
export function unmeasuredScenarios(domain: DomainData, run: Run): Scenario[] {
  const present = new Set<string>();
  for (const scen of Object.values(run.results ?? {})) for (const sid of Object.keys(scen ?? {})) present.add(sid);
  return sortScenarios(domain.scenarios).filter((s) => !present.has(s.id));
}

/** Scenarios with data in this run, in display order. */
export function measuredScenarios(domain: DomainData, run: Run): Scenario[] {
  const missing = new Set(unmeasuredScenarios(domain, run).map((s) => s.id));
  return sortScenarios(domain.scenarios).filter((s) => !missing.has(s.id));
}

/** Display order of metric groups; unknown groups follow in first-seen order. */
export const GROUP_ORDER = [
  'summary',
  'time',
  'throughput',
  'latency',
  'cpu',
  'memory',
  'database',
  'startup',
  'footprint',
  'stability',
  'energy',
  'network',
  'io',
  'quality',
];

/** Groups of the registry in display order, with their metrics in registry order. */
export function metricGroups(domain: Pick<DomainData, 'metrics'>): Array<{ group: string; metrics: Metric[] }> {
  const groups = new Map<string, Metric[]>();
  for (const m of Object.values(domain.metrics)) {
    const list = groups.get(m.group) ?? [];
    list.push(m);
    groups.set(m.group, list);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()]
    .map(([group, metrics], index) => ({ group, metrics, index }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index)
    .map(({ group, metrics }) => ({ group, metrics }));
}

/** Metric ids grouped for display: groups in GROUP_ORDER (unknown groups after), ids in the given order. */
export function groupMetricIds(metrics: MetricRegistry, ids: string[]): Array<{ group: string; ids: string[] }> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const g = metrics[id]?.group ?? 'other';
    groups.set(g, [...(groups.get(g) ?? []), id]);
  }
  const rank = (g: string) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  // Array.prototype.sort is stable, so groups outside GROUP_ORDER keep their first-seen order.
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([group, ids]) => ({ group, ids }));
}

/** Primary metrics first (given order), then the rest grouped as in groupMetricIds. */
export function displayOrder(metrics: MetricRegistry, ids: string[]): string[] {
  const { primary, secondary, diagnostic } = byVisibility(metrics, ids);
  return [...primary, ...groupMetricIds(metrics, [...secondary, ...diagnostic]).flatMap((g) => g.ids)];
}

const GROUP_LABELS: Record<string, string> = {
  summary: 'Summary',
  time: 'Time',
  throughput: 'Throughput',
  latency: 'Latency',
  cpu: 'CPU',
  memory: 'Memory',
  database: 'Database',
  startup: 'Start-up',
  footprint: 'Footprint',
  stability: 'Stability',
  energy: 'Energy',
  network: 'Network',
  io: 'Disk I/O',
  quality: 'Measurement quality',
};

export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? capitalize(group.replace(/[_-]+/g, ' '));
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The scenario a derived metric is computed from, as a readable sentence. */
export function derivedExplanation(domain: Pick<DomainData, 'derived' | 'metrics' | 'scenarios'>, metricId: string): string | null {
  const def = (domain.derived ?? []).find((d) => d.id === metricId);
  if (!def) return null;
  const source = domain.metrics[def.metric]?.label ?? def.metric;
  const titles =
    def.scenarios === '*'
      ? 'any scenario'
      : def.scenarios.map((s) => domain.scenarios.find((x) => x.id === s)?.title ?? s).join(', ');
  if (def.kind === 'geomean_relative') {
    // The direction of publish.derive: the best is the highest value of a higher-is-better metric, else the lowest,
    // and the ratio is always arranged so that the best implementation scores 1.
    const higher = domain.metrics[def.metric]?.better === 'higher';
    const ratio = higher
      ? `this implementation's “${source}” divided by the best (highest) one`
      : `the best (lowest) “${source}” divided by this implementation's`;
    const where = def.scenarios === '*' ? 'In every scenario' : `In each of the declared scenarios (${titles})`;
    return `${where}: ${ratio}, the best being taken among the implementations that have an index. The index is the geometric mean of those ratios times 100, so 100 means best in every one of them. Only implementations with a usable result in every one of them get an index, and only they are compared with each other, so another set of implementations can change it. A scenario in which the best value is zero is left out for everybody; the scale above the values counts the scenarios this run's index was computed over.`;
  }
  if (def.kind === 'max') return `Highest median “${source}” in ${titles}.`;
  return `${capitalize(def.kind.replace(/_/g, ' '))} of “${source}” over ${titles}.`;
}

/**
 * Short scale of a relative index in one run for column heads: "100 = best in all 6 scenarios". The count is that of
 * the scenarios the publisher computed the index over (`run.best`), never the declared list, so it cannot be wrong;
 * a run in which nobody has the index gets no scale.
 */
export function derivedScale(domain: { derived?: DerivedDefinition[] }, metricId: string, run: Pick<Run, 'best'>): string | null {
  const def = (domain.derived ?? []).find((d) => d.id === metricId);
  if (def?.kind !== 'geomean_relative') return null;
  const n = Object.keys(run.best?.[metricId] ?? {}).length;
  if (!n) return null;
  return n === 1 ? '100 = best in its one scenario' : `100 = best in all ${n} scenarios`;
}

/** Every relative index of a run with its scale (see derivedScale), for islands that only get the run's values. */
export function derivedScales(domain: { derived?: DerivedDefinition[] }, run: Pick<Run, 'best'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of domain.derived ?? []) {
    const scale = derivedScale(domain, d.id, run);
    if (scale) out[d.id] = scale;
  }
  return out;
}

/**
 * The publisher's reasons for withholding a derived metric, as visible sentences: one per reason, naming the
 * implementations (in the given order) it applies to, or "any implementation" when `ids` are all implementations of
 * the run (`wholeRun`) and it applies to every one of them; a selection is always named.
 * With `label` (the index's name) a line starts "Throughput index: no index for …". Empty when nothing is withheld. Hover titles do not reach touch screens; these lines do.
 */
export function withheldLines(
  run: Pick<Run, 'withheld'>,
  ids: string[],
  metric: string,
  nameOf: (id: string) => string,
  label?: string,
  wholeRun = false,
): string[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const why = run.withheld?.[id]?.[metric];
    if (typeof why === 'string' && why) groups.set(why, [...(groups.get(why) ?? []), id]);
  }
  return [...groups].map(([why, who]) => {
    const whom = wholeRun && who.length === ids.length && ids.length > 1 ? 'any implementation' : listNames(who.map(nameOf));
    return `${label ? `${label}: no index` : 'No index'} for ${whom}. ${why}.`;
  });
}

/**
 * One sentence for a card whose derived headline value nobody has: the publisher's reason when all implementations
 * share it, otherwise a pointer to the per-implementation reasons. Null when nothing was withheld (the metric was
 * not measured in the run, which the card says itself) or for a scenario metric.
 */
export function noIndexSentence(run: Pick<Run, 'withheld'>, ids: string[], entry: HeadlineEntry): string | null {
  if (entry.scenario) return null;
  const reasons = ids.map((id) => run.withheld?.[id]?.[entry.metric]);
  if (!reasons.some((r) => typeof r === 'string' && r)) return null;
  const first = reasons[0];
  if (typeof first === 'string' && first && reasons.every((r) => r === first)) return `No implementation has an index in this run. ${first}.`;
  return 'No implementation has an index in this run; the results give the reason for each.';
}

function listNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const KIND_LABELS: Record<string, string> = {
  startup: 'Start-up',
  cold: 'Cold load',
  http: 'Closed loop',
  rate: 'Fixed rate',
  soak: 'Soak',
};

export function scenarioKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? capitalize(kind.replace(/[_-]+/g, ' '));
}

function workText(work: unknown): string | null {
  if (!work || typeof work !== 'object') return null;
  const parts = Object.entries(work as Record<string, unknown>)
    .filter(([, n]) => isNum(n))
    .map(([k, n]) => `${formatNumber(n as number, 0)} ${k.toUpperCase()}`);
  return parts.length ? `${parts.join(' + ')} per request` : null;
}

/** Short, readable descriptions of a scenario's parameters ("GET /db", "5,000 req/s", ...). */
export function scenarioParams(scenario: Scenario, all: Scenario[] = []): string[] {
  const p = (scenario.params ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (typeof p.path === 'string') out.push(`${typeof p.method === 'string' ? p.method : 'GET'} ${p.path}`);
  if (isNum(p.rate)) out.push(`${formatNumber(p.rate, 0)} req/s fixed`);
  if (isNum(p.connections)) out.push(`${formatNumber(p.connections, 0)} connections`);
  if (isNum(p.cpus)) out.push(p.cpus === 1 ? 'one core' : `${formatNumber(p.cpus, 0)} cores`);
  if (isNum(p.slices) && typeof p.slice_duration === 'string') out.push(`${formatNumber(p.slices, 0)} × ${p.slice_duration}`);
  else if (typeof p.duration === 'string') out.push(`${p.duration} measured`);
  const work = workText(p.work);
  if (work) out.push(work);
  if (typeof p.compare_to === 'string') {
    const other = all.find((s) => s.id === p.compare_to);
    out.push(`compared with ${other?.title ?? p.compare_to}`);
  }
  if (typeof p.body === 'string') out.push(`body ${p.body}`);
  if (p.optional === true) out.push('optional');
  return out;
}

/* ----------------------------------------------------------------------------------------------
 * Categories, languages, provenance, machines
 * -------------------------------------------------------------------------------------------- */

export const CATEGORY_ORDER = ['bare', 'micro', 'framework', 'fullstack', 'tool'];

const CATEGORY_INFO: Record<string, { label: string; description: string }> = {
  bare: { label: 'Bare', description: 'No framework: the runtime or server with hand-written routing.' },
  micro: { label: 'Micro', description: 'A minimal framework or the standard library HTTP server.' },
  framework: { label: 'Framework', description: 'A mainstream web framework used the way its documentation recommends.' },
  fullstack: { label: 'Full-stack', description: 'A full application framework with dependency injection, data access and more.' },
  tool: { label: 'Tool', description: 'A tool rather than an application framework.' },
};

export function categoryLabel(category: string): string {
  return CATEGORY_INFO[category]?.label ?? capitalize(category);
}

export function categoryDescription(category: string): string {
  return CATEGORY_INFO[category]?.description ?? '';
}

export function languages(impls: Implementation[]): string[] {
  return [...new Set(impls.map((i) => i.language))].sort((a, b) => a.localeCompare(b));
}

export function categories(impls: Implementation[]): string[] {
  const present = new Set(impls.map((i) => i.category));
  const known = CATEGORY_ORDER.filter((c) => present.has(c));
  const unknown = [...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...unknown];
}

/** How a domain's status reads next to its numbers; null for a stable domain. */
export function domainStatus(status: string | undefined): { label: string; description: string } | null {
  if (status === 'experimental')
    return {
      label: 'Experimental',
      description: 'An experimental domain: its workloads and methodology may still change, and its results are less settled than those of a stable domain.',
    };
  return null;
}

export interface ProvenanceInfo {
  id: string;
  label: string;
  description: string;
}

export function provenanceInfo(p: string | null | undefined): ProvenanceInfo {
  if (p === 'reference')
    return {
      id: 'reference',
      label: 'Reference',
      description: 'Measured by the maintainers themselves; the run id is listed in results/reference-runs.toml.',
    };
  if (p === 'community')
    return {
      id: 'community',
      label: 'Community',
      description:
        "Submitted as a result bundle and not on the maintainers' list of reference runs. CI verified that the bundle is internally consistent.",
    };
  return { id: 'unknown', label: 'Unlabelled', description: 'The dataset does not say who measured this run.' };
}

export interface CommunityStatus {
  /** Published runs across all domains. */
  runs: number;
  /** Runs by provenance; `unlabelled` are runs whose provenance the dataset does not state. */
  reference: number;
  community: number;
  unlabelled: number;
  /** Distinct machines with at least one run, and how many of them have a community run. */
  machines: number;
  communityMachines: number;
  /** Implementations across all domains. */
  implementations: number;
  domains: number;
}

/** Who measured what: the honest, dataset-derived state of the community model. */
export function communityStatus(domains: Array<Pick<DomainData, 'runs' | 'implementations'>>): CommunityStatus {
  const status: CommunityStatus = {
    runs: 0,
    reference: 0,
    community: 0,
    unlabelled: 0,
    machines: 0,
    communityMachines: 0,
    implementations: 0,
    domains: domains.length,
  };
  const machines = new Set<string>();
  const communityMachines = new Set<string>();
  for (const d of domains) {
    status.implementations += d.implementations.length;
    for (const run of d.runs) {
      status.runs += 1;
      machines.add(run.machine);
      const id = provenanceInfo(run.provenance).id;
      if (id === 'reference') status.reference += 1;
      else if (id === 'community') {
        status.community += 1;
        communityMachines.add(run.machine);
      } else status.unlabelled += 1;
    }
  }
  status.machines = machines.size;
  status.communityMachines = communityMachines.size;
  return status;
}

/** One sentence on community runs; with none yet it reads as an invitation, never as a claim. */
export function communityRunsNote(status: Pick<CommunityStatus, 'community' | 'communityMachines'>): string {
  if (status.community === 0) return 'No community runs yet. Add the first.';
  const runs = `${status.community} community ${status.community === 1 ? 'run' : 'runs'}`;
  const machines = `${status.communityMachines} ${status.communityMachines === 1 ? 'machine' : 'machines'}`;
  return `${runs} from ${machines} so far.`;
}

/** True when the machine fingerprint names a hypervisor ("none" is bare metal; an unrecorded value is not a claim). */
export function isVirtualMachine(machine: Pick<Machine, 'virtualization'> | undefined): boolean {
  const v = machine?.virtualization;
  return typeof v === 'string' && v !== '' && v !== 'none';
}

/**
 * The machine's name up to its first detail ("Intel Xeon W-2133" of "Intel Xeon W-2133 · 6 cores / 12 threads",
 * "Boat sandbox" of "Boat sandbox (cloud VM, 8 vCPU)"), for places as narrow as a select on a phone.
 */
export function machineShortName(machine: Machine | undefined, fallbackId = ''): string {
  const name = machineName(machine, fallbackId);
  return name.split(/ · | \(/)[0]!.trim() || name;
}

/** Human-readable machine name: the reference label if the machine is a reference machine. */
export function machineName(machine: Machine | undefined, fallbackId = ''): string {
  return machine?.reference?.label || machine?.label || machine?.id || fallbackId || 'Unknown machine';
}

/* ----------------------------------------------------------------------------------------------
 * Flags
 * -------------------------------------------------------------------------------------------- */

export function flagImplementation(flag: Flag): string | null {
  if (!flag.scope || flag.scope === 'run') return null;
  return flag.scope.split('/')[0] ?? null;
}

export function flagScenario(flag: Flag): string | null {
  if (!flag.scope || flag.scope === 'run') return null;
  const parts = flag.scope.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : null;
}

export function flagsForImplementation(run: Run, impl: string): Flag[] {
  return (run.flags ?? []).filter((f) => flagImplementation(f) === impl);
}

export function runLevelFlags(run: Run): Flag[] {
  return (run.flags ?? []).filter((f) => flagImplementation(f) === null);
}

export function flagsFor(run: Run, impl: string, scenario: string): Flag[] {
  return (run.flags ?? []).filter((f) => flagImplementation(f) === impl && flagScenario(f) === scenario);
}

/** What the flag and value helpers need to know about the domain (islands get these as props). */
export interface ValueContext {
  derived?: DerivedDefinition[];
  scenarios: Array<Pick<Scenario, 'id' | 'title'>>;
}

/** The scenarios a derived metric is computed from; '*' (or an unknown definition) means every scenario. */
function derivedSources(ctx: ValueContext, metric: string): Set<string> | '*' {
  const def = (ctx.derived ?? []).find((d) => d.id === metric);
  return !def || def.scenarios === '*' ? '*' : new Set(def.scenarios);
}

/**
 * The quality flags behind one value: flags scoped to the whole implementation, plus those of the scenario
 * (scenario value) or of every scenario the derived metric is computed from (`scenario` null).
 * A flag with `metric` is about that metric only: it reaches a scenario value of that metric, or a derived value
 * computed from it (`derived[].metric`); never another metric. Flags without `metric` cover every value in scope.
 * Leaderboard, explorer, implementation page and compare all use this, so they cannot disagree.
 */
export function valueFlags(ctx: ValueContext, flags: Flag[] | undefined, impl: string, scenario: string | null, metric: string): Flag[] {
  const sources = scenario ? new Set([scenario]) : derivedSources(ctx, metric);
  const basis = scenario ? metric : (ctx.derived ?? []).find((d) => d.id === metric)?.metric;
  return (flags ?? []).filter((f) => {
    if (flagImplementation(f) !== impl) return false;
    if (f.metric && f.metric !== basis) return false;
    const s = flagScenario(f);
    return s === null || sources === '*' || sources.has(s);
  });
}

const FLAG_RANK: Record<string, number> = { info: 1, warning: 2, error: 3 };

/** The most severe level in a flag list (an unknown level counts as a warning); null for no flags. */
export function highestFlagLevel(flags: Flag[]): 'info' | 'warning' | 'error' | null {
  let best = 0;
  for (const f of flags) best = Math.max(best, FLAG_RANK[f.level] ?? FLAG_RANK.warning!);
  return best === 3 ? 'error' : best === 2 ? 'warning' : best === 1 ? 'info' : null;
}

/**
 * The flags behind one value, ready to render: `alert` (the amber marker) when any is a warning or error,
 * `info` (a quiet, muted marker) when all are info notes. Every flag marker on the site is drawn from this.
 */
export interface FlagNote {
  marker: 'alert' | 'info';
  texts: string[];
}

export function flagNote(ctx: ValueContext, flags: Flag[]): FlagNote | null {
  const level = highestFlagLevel(flags);
  if (!level) return null;
  return { marker: level === 'info' ? 'info' : 'alert', texts: flags.map((f) => flagText(ctx, f)) };
}

/** True when an implementation has at least one warning or error in the run (the leaderboard's "flagged" tag). */
export function hasAlertFlags(flags: Flag[]): boolean {
  const level = highestFlagLevel(flags);
  return level === 'warning' || level === 'error';
}

/** "Orders: throughput varies 17 % between passes (pass 2)"; implementation-wide flags say so. */
export function flagText(ctx: ValueContext, flag: Flag): string {
  const s = flagScenario(flag);
  const where = s ? (ctx.scenarios.find((x) => x.id === s)?.title ?? s) : 'Whole measurement';
  return `${where}: ${flag.message}${flag.pass ? ` (pass ${flag.pass})` : ''}`;
}

/** The flag marker of one value (valueFlags + flagNote); null when nothing is flagged. */
export function valueFlagNote(ctx: ValueContext, flags: Flag[] | undefined, impl: string, scenario: string | null, metric: string): FlagNote | null {
  return flagNote(ctx, valueFlags(ctx, flags, impl, scenario, metric));
}

/**
 * How a missing value reads. The publisher withholds a derived index when a workload behind it is missing,
 * zero or fails too many requests, and records why in `run.withheld`: that reads "no index" with the
 * reason, never zero and never as unexplained missing data.
 */
export function missingValue(
  run: Pick<Run, 'withheld'>,
  impl: string,
  scenario: string | null,
  metric: string,
): { label: string; reason: string } {
  const why = scenario ? undefined : run.withheld?.[impl]?.[metric];
  if (why) return { label: 'no index', reason: `No index: ${why}.` };
  return { label: 'not measured', reason: 'Not measured in this run.' };
}

/* ----------------------------------------------------------------------------------------------
 * Winners per scenario
 * -------------------------------------------------------------------------------------------- */

export interface ScenarioWinner {
  scenario: Scenario;
  /** The best value (the shared value when several implementations tie). */
  value: Value;
  /** Every implementation with the best value, in the run's implementation order. */
  winners: string[];
  /** How many implementations have this index in the run (and so competed for every scenario). */
  eligible: number;
}

/**
 * The fastest implementation in each scenario behind a relative index: the "best = 100" reference that the
 * publisher wrote to `run.best[derivedId]`. Eligibility is the publisher's alone; nothing is re-derived here.
 * Scenarios follow the domain's display order; ties list every winner. A run without `best` (or without an
 * entry for this index) yields nothing.
 */
export function scenarioWinners(
  domain: Pick<DomainData, 'derived' | 'scenarios' | 'implementations'>,
  run: Run,
  derivedId: string,
): ScenarioWinner[] {
  const best = run.best?.[derivedId];
  const metric = (domain.derived ?? []).find((d) => d.id === derivedId)?.metric;
  if (!best || !metric) return [];
  const inRun = new Set(runImplementationIds(domain, run));
  const eligible = Object.values(run.derived ?? {}).filter((d) => isNum(d?.[derivedId])).length;
  const out: ScenarioWinner[] = [];
  for (const scenario of sortScenarios(domain.scenarios)) {
    const ref = best[scenario.id];
    if (!ref) continue;
    const winners = ref.by.filter((id) => inRun.has(id));
    const value = winners[0] ? metricValue(run, scenario.id, metric, winners[0]) : null;
    if (value) out.push({ scenario, value, winners, eligible });
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------
 * Relative differences (compare view)
 * -------------------------------------------------------------------------------------------- */

export type Tone = 'better' | 'worse' | 'same' | 'neutral';

export interface RelativeDiff {
  /** value / baseline */
  ratio: number;
  tone: Tone;
  /** "+12 %", "−34 %", "< +0.1 %", "2.4× higher", "3.1× lower"; "same" only for exactly equal values. */
  text: string;
}

export function relativeDiff(value: number | null | undefined, baseline: number | null | undefined, better: Better): RelativeDiff | null {
  if (!isNum(value) || !isNum(baseline) || baseline === 0) return null;
  const ratio = value / baseline;
  if (!isNum(ratio)) return null;
  if (value === baseline) return { ratio, tone: 'same', text: 'same' };
  let tone: Tone = 'neutral';
  if (better === 'higher') tone = value > baseline ? 'better' : 'worse';
  if (better === 'lower') tone = value < baseline ? 'better' : 'worse';
  let text: string;
  if (ratio >= 2) text = `${formatNumber(ratio, 1)}× higher`;
  else if (ratio > 0 && ratio <= 0.5) text = `${formatNumber(1 / ratio, 1)}× lower`;
  else {
    const pct = (ratio - 1) * 100;
    const decimals = Math.abs(pct) < 10 ? 1 : 0;
    // A non-zero difference below the displayed precision keeps its direction: "< +0.1 %", "> −0.1 %".
    if (Math.abs(pct) < 0.05) text = pct > 0 ? `<${UNIT_SPACE}+0.1${UNIT_SPACE}%` : `>${UNIT_SPACE}${MINUS}0.1${UNIT_SPACE}%`;
    else text = `${pct > 0 ? '+' : MINUS}${formatNumber(Math.abs(pct), decimals)}${UNIT_SPACE}%`;
  }
  return { ratio, tone, text };
}

/** Whether the confidence intervals of two values overlap; null when either has no interval. */
export function intervalsOverlap(a: Value | null, b: Value | null): boolean | null {
  if (!a || !b || a.derived || b.derived) return null;
  if (!hasInterval(a) || !hasInterval(b)) return null;
  return a.lo <= b.hi && b.lo <= a.hi;
}

/**
 * How a difference to the baseline may be described. Overlapping 95 % intervals are reported as such (not
 * as "no difference"); without an interval on both sides (fewer than five passes, or a derived metric)
 * the direction is only an observed difference of the medians, with no claim about uncertainty.
 */
export interface DiffAssessment {
  /** Styling: better/worse only when the intervals separate the two values. */
  tone: Tone;
  /** Short word next to the number: "better", "worse", "better (observed)", "95 % intervals overlap". */
  word: string;
  /** Tooltip that says what the label can and cannot claim. */
  title: string;
  observed: boolean;
}

export function assessDiff(diff: RelativeDiff, a: Value | null, b: Value | null): DiffAssessment {
  if (diff.tone === 'same' || diff.tone === 'neutral')
    return { tone: diff.tone, word: '', title: diff.text, observed: false };
  const overlap = intervalsOverlap(a, b);
  if (overlap === true)
    return {
      tone: 'same',
      word: '95 % intervals overlap',
      title: `Observed ${diff.text} (${diff.tone}), but the 95 % intervals of the two medians overlap, so this run does not separate them.`,
      observed: false,
    };
  if (overlap === false)
    return {
      tone: diff.tone,
      word: diff.tone,
      title: `${diff.text} ${diff.tone}; the 95 % intervals of the two medians do not overlap.`,
      observed: false,
    };
  const why = a?.derived || b?.derived ? 'derived values carry no interval' : 'no 95 % interval (fewer than five passes)';
  return {
    tone: diff.tone,
    word: `${diff.tone} (observed)`,
    title: `Observed difference of the medians: ${diff.text} ${diff.tone}. ${capitalize(why)}, so it is unknown whether it exceeds run-to-run noise.`,
    observed: true,
  };
}

export interface Suggestion {
  title: string;
  ids: string[];
  /** What is compared and how fair it is; only comparisons the domain declares have one. */
  note: string | null;
}

/**
 * Suggested comparisons. A domain that declares them (`domain.compare`) gets those, in its order, limited to the
 * given ids. Otherwise they come from the data: variants built from the same source and implementations that share
 * a runtime. Each suggestion has 2–`max` members and appears once.
 */
export function suggestedComparisons(domain: DomainData, ids: string[], max = 4): Suggestion[] {
  const impls = ids.map((id) => implementation(domain, id));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (title: string, members: Array<Pick<Implementation, 'id'>>, note: string | null = null) => {
    const list = members.slice(0, max).map((m) => m.id);
    const key = [...list].sort().join(',');
    if (list.length < 2 || seen.has(key)) return;
    seen.add(key);
    out.push({ title, ids: list, note });
  };
  // A domain that declares its comparisons has said what is worth comparing; the guesses below are for the others.
  if (domain.domain.compare?.length) {
    for (const s of declaredSuggestions(domain, ids, max)) add(s.title, s.ids.map((id) => ({ id })), s.note);
    return out;
  }
  const bySource = new Map<string, Implementation[]>();
  for (const i of impls) if (i.source) bySource.set(i.source, [...(bySource.get(i.source) ?? []), i]);
  for (const members of bySource.values()) {
    const framework = members[0]?.framework ?? members[0]?.name ?? '';
    const variants = [...new Set(members.map((m) => m.variant).filter(Boolean))];
    add(variants.length ? `${framework}: ${variants.join(' vs ')}` : `${framework} variants`, members);
  }
  const byRuntime = new Map<string, Implementation[]>();
  for (const i of impls) if (i.runtime) byRuntime.set(i.runtime, [...(byRuntime.get(i.runtime) ?? []), i]);
  for (const [runtime, members] of byRuntime) {
    if (members.length < 2 || members.every((m) => m.source && m.source === members[0]?.source)) continue;
    add(`${runtime}: ${members.map((m) => m.framework ?? m.name).join(' vs ')}`, members);
  }
  return out;
}

/**
 * The comparisons the domain declares (`domain.compare`) whose every member is among the given ids. Title and note
 * describe exactly the declared members, so a comparison with a member missing from the run is not offered at all
 * (never a smaller comparison under a title and note written for more).
 */
export function declaredSuggestions(domain: Pick<DomainData, 'domain'>, ids: string[], max = 4): Suggestion[] {
  const present = new Set(ids);
  return (domain.domain.compare ?? [])
    .filter((c) => c.ids.length >= 2 && c.ids.length <= max && c.ids.every((id) => present.has(id)))
    .map((c) => ({ title: c.title, ids: [...c.ids], note: c.note ?? null }));
}

/** The comparison the domain declares for exactly this selection (any order), or null. */
export function declaredComparison(domain: Pick<DomainData, 'domain'>, ids: string[]): DeclaredComparison | null {
  const key = [...ids].sort().join(',');
  return (domain.domain.compare ?? []).find((c) => [...c.ids].sort().join(',') === key) ?? null;
}

/**
 * The first clause of a domain's ranking note ("Mixed TypeScript revisions"), for a ranking that stands far from
 * the full note; the whole note when it has a single clause. A period only ends a clause before a space, so
 * version numbers stay intact.
 */
export function rankingNoteShort(note: string | undefined): string {
  const text = (note ?? '').trim();
  const m = /^(.+?)[:;.](?:\s|$)/.exec(text);
  return m ? m[1]!.trim() : text;
}

/* ----------------------------------------------------------------------------------------------
 * Repository links
 * -------------------------------------------------------------------------------------------- */

function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function repoUrl(project: Pick<Project, 'repository'>, path = '', kind: 'tree' | 'blob' = 'tree', ref = 'main'): string {
  const repo = project.repository.replace(/\/+$/, '');
  const clean = normalizePosix(path);
  return clean ? `${repo}/${kind}/${ref}/${clean}` : repo;
}

/** A repository page on the forge: issues (bugs, proposals) or discussions (ideas, questions). */
export function repoPage(project: Pick<Project, 'repository'>, page: 'issues' | 'discussions'): string {
  return `${project.repository.replace(/\/+$/, '')}/${page}`;
}

function siteOrigin(project: Pick<Project, 'site_url'>): string {
  return (project.site_url ?? '').replace(/\/+$/, '');
}

/**
 * The one-line installer, or null when the project has no site URL. The website serves the repository's
 * install.sh (Linux, macOS, WSL) and install.ps1 (Windows PowerShell) at the root of the public site.
 */
export function installCommand(project: Pick<Project, 'site_url'>, system: 'unix' | 'windows' = 'unix'): string | null {
  const site = siteOrigin(project);
  if (!site) return null;
  return system === 'windows' ? `irm ${site}/install.ps1 | iex` : `curl -fsSL ${site}/install.sh | sh`;
}

/**
 * The prompt to paste into an AI coding agent: it points the agent at docs/install.md, which the website serves
 * at /install.md. Null when the project has no site URL.
 */
export function installPrompt(project: Pick<Project, 'name' | 'slug' | 'site_url'>): string | null {
  const site = siteOrigin(project);
  if (!site) return null;
  return [
    `Install the ${project.name} CLI on this machine by following ${site}/install.md.`,
    `Then run \`${project.slug} doctor\` and tell me whether this machine can run the benchmarks.`,
  ].join('\n');
}

/** Links to an implementation's directory and, if it builds from shared sources, to those. */
export function implementationLinks(
  project: Pick<Project, 'repository'>,
  domainId: string,
  impl: Pick<Implementation, 'id' | 'source'>,
): { directory: string; source: string | null; sourcePath: string | null } {
  const dir = `domains/${domainId}/implementations/${impl.id}`;
  const sourcePath = typeof impl.source === 'string' && impl.source ? normalizePosix(`${dir}/${impl.source}`) : null;
  return {
    directory: repoUrl(project, dir, 'tree'),
    source: sourcePath ? repoUrl(project, sourcePath, 'tree') : null,
    sourcePath,
  };
}

/** The raw result bundle of a run in the repository. */
export function bundlePath(domainId: string, run: Pick<Run, 'id' | 'machine'>): string {
  return `results/${domainId}/${run.machine}/${run.id}.json`;
}

export function bundleUrl(project: Pick<Project, 'repository'>, domainId: string, run: Pick<Run, 'id' | 'machine'>): string {
  return repoUrl(project, bundlePath(domainId, run), 'blob');
}

/** Licence URL for an SPDX identifier. */
export function licenseUrl(spdx: string | undefined): string | null {
  if (!spdx) return null;
  return `https://spdx.org/licenses/${encodeURIComponent(spdx)}.html`;
}
