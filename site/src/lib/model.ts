/**
 * Pure view-model logic on top of the dataset: runs, values, ranking, metric selection, flags,
 * relative differences and repository links. No I/O here, so everything is unit-testable and can be
 * shared by server-rendered pages and client islands.
 */
import { formatNumber, hasInterval, isNum, MINUS, UNIT_SPACE } from './format';
import type {
  Better,
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
export function runImplementationIds(domain: DomainData, run: Run): string[] {
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

/** "C# · ASP.NET Core 10 LTS (Native AOT)" */
export function implLabel(impl: Pick<Implementation, 'name' | 'variant'>): string {
  return impl.variant ? `${impl.name} (${impl.variant})` : impl.name;
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
type RunValues = Pick<Run, 'results' | 'derived'>;

/** Metric ids with at least one value in a scenario of a run (null scenario = derived), registry order. */
export function measuredMetricIds(metrics: MetricRegistry, run: RunValues, scenario: string | null): string[] {
  const found = new Set<string>();
  if (!scenario) {
    for (const values of Object.values(run.derived ?? {}))
      for (const [k, v] of Object.entries(values ?? {})) if (isNum(v)) found.add(k);
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

/** Every metric id that has a value anywhere in the run (results or derived). */
export function metricIdsInRun(run: RunValues): Set<string> {
  const ids = new Set<string>();
  for (const scen of Object.values(run.results ?? {}))
    for (const metrics of Object.values(scen ?? {})) for (const [k, v] of Object.entries(metrics ?? {})) if (isStat(v)) ids.add(k);
  for (const values of Object.values(run.derived ?? {})) for (const [k, v] of Object.entries(values ?? {})) if (isNum(v)) ids.add(k);
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
  if (def.kind === 'geomean_relative')
    return `Geometric mean of “${source}” over ${titles}, each relative to the best implementation in that scenario (best = 100). Only an implementation that is best in every one of them reaches 100, and only implementations with a usable result in every one of them get an index.`;
  if (def.kind === 'max') return `Highest median “${source}” in ${titles}.`;
  return `${capitalize(def.kind.replace(/_/g, ' '))} of “${source}” over ${titles}.`;
}

/** Short scale of a relative index for column heads: "100 = best in all 6 scenarios". */
export function derivedScale(domain: { derived?: DerivedDefinition[] }, metricId: string): string | null {
  const def = (domain.derived ?? []).find((d) => d.id === metricId);
  if (def?.kind !== 'geomean_relative') return null;
  return def.scenarios === '*' ? '100 = best in every scenario' : `100 = best in all ${def.scenarios.length} scenarios`;
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
 * Leaderboard, explorer, implementation page and compare all use this, so they cannot disagree.
 */
export function valueFlags(ctx: ValueContext, flags: Flag[] | undefined, impl: string, scenario: string | null, metric: string): Flag[] {
  const sources = scenario ? new Set([scenario]) : derivedSources(ctx, metric);
  return (flags ?? []).filter((f) => {
    if (flagImplementation(f) !== impl) return false;
    const s = flagScenario(f);
    return s === null || sources === '*' || sources.has(s);
  });
}

/** "Orders: throughput varies 17 % between passes (pass 2)"; implementation-wide flags say so. */
export function flagText(ctx: ValueContext, flag: Flag): string {
  const s = flagScenario(flag);
  const where = s ? (ctx.scenarios.find((x) => x.id === s)?.title ?? s) : 'Whole measurement';
  return `${where}: ${flag.message}${flag.pass ? ` (pass ${flag.pass})` : ''}`;
}

export function valueFlagTexts(ctx: ValueContext, flags: Flag[] | undefined, impl: string, scenario: string | null, metric: string): string[] {
  return valueFlags(ctx, flags, impl, scenario, metric).map((f) => flagText(ctx, f));
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

/**
 * Suggested comparisons from the data: variants built from the same source, and implementations
 * that share a runtime. Each suggestion has 2–`max` members.
 */
export function suggestedComparisons(domain: DomainData, ids: string[], max = 4): Array<{ title: string; ids: string[] }> {
  const impls = ids.map((id) => implementation(domain, id));
  const out: Array<{ title: string; ids: string[] }> = [];
  const seen = new Set<string>();
  const add = (title: string, members: Implementation[]) => {
    const list = members.slice(0, max).map((m) => m.id);
    const key = [...list].sort().join(',');
    if (list.length < 2 || seen.has(key)) return;
    seen.add(key);
    out.push({ title, ids: list });
  };
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
