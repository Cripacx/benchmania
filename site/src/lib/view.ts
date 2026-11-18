/**
 * Compact slices of the dataset passed to client islands as props. Keep these small: they are
 * serialized into the HTML of every page that hydrates an island.
 */
import { implementation, runImplementationIds } from './model';
import type { DomainData, Implementation, Metric, Run, Scenario, Stat } from './types';

export interface ImplLite {
  id: string;
  name: string;
  variant: string | null;
  language: string;
  category: string;
  runtime: string | null;
  framework: string | null;
}

export interface RunSlice {
  id: string;
  passes: number;
  results: Record<string, Record<string, Record<string, Stat>>>;
  derived: Record<string, Record<string, number>>;
  /** implementation → derived metric → why the value was withheld */
  withheld: Record<string, Record<string, string>>;
}

export interface RunOption {
  id: string;
  label: string;
  href: string;
  provenance: string;
  methodology: string;
  isDefault: boolean;
}

export function implLite(impl: Implementation): ImplLite {
  return {
    id: impl.id,
    name: impl.name,
    variant: impl.variant ?? null,
    language: impl.language,
    category: impl.category,
    runtime: impl.runtime ?? null,
    framework: impl.framework ?? null,
  };
}

export function runImpls(domain: DomainData, run: Run): ImplLite[] {
  return runImplementationIds(domain, run).map((id) => implLite(implementation(domain, id, run)));
}

/** Results and derived values only, without manifests and metadata. */
export function runSlice(run: Run): RunSlice {
  return { id: run.id, passes: run.passes, results: run.results ?? {}, derived: run.derived ?? {}, withheld: run.withheld ?? {} };
}

/** Registry without empty descriptions, to keep props lean. */
export function metricRegistry(domain: DomainData): Record<string, Metric> {
  const out: Record<string, Metric> = {};
  for (const [id, m] of Object.entries(domain.metrics)) {
    const copy: Metric = { id: m.id, label: m.label, unit: m.unit, better: m.better, group: m.group };
    if (m.description) copy.description = m.description;
    if (typeof m.decimals === 'number') copy.decimals = m.decimals;
    if (m.visibility) copy.visibility = m.visibility;
    out[id] = copy;
  }
  return out;
}

export function scenarioLite(s: Scenario): Scenario {
  const copy: Scenario = { id: s.id, title: s.title, kind: s.kind, order: s.order };
  if (s.description) copy.description = s.description;
  if (s.params) copy.params = s.params;
  return copy;
}

/**
 * Compact transport format for run results: id tables plus numeric rows, so the serialized island
 * props stay small even for runs with many passes and metrics.
 *   stats:   [impl, scenario, metric, m, lo, hi, min, max, n, cv]   (indices into the id tables)
 *   derived: [impl, metric, value]
 */
export interface PackedRun {
  id: string;
  passes: number;
  impls: string[];
  scenarios: string[];
  metrics: string[];
  stats: Array<Array<number | null>>;
  derived: number[][];
  withheld: Record<string, Record<string, string>>;
}

export function packRun(run: RunSlice): PackedRun {
  const impls: string[] = [];
  const scenarios: string[] = [];
  const metrics: string[] = [];
  const idx = (list: string[], id: string) => {
    let i = list.indexOf(id);
    if (i === -1) i = list.push(id) - 1;
    return i;
  };
  const stats: Array<Array<number | null>> = [];
  for (const [impl, scen] of Object.entries(run.results ?? {}))
    for (const [sid, values] of Object.entries(scen ?? {}))
      for (const [mid, s] of Object.entries(values ?? {})) {
        if (!s || typeof s.m !== 'number' || !Number.isFinite(s.m)) continue;
        stats.push([idx(impls, impl), idx(scenarios, sid), idx(metrics, mid), s.m, s.lo, s.hi, s.min, s.max, s.n, s.cv]);
      }
  const derived: number[][] = [];
  for (const [impl, values] of Object.entries(run.derived ?? {}))
    for (const [mid, v] of Object.entries(values ?? {}))
      if (typeof v === 'number' && Number.isFinite(v)) derived.push([idx(impls, impl), idx(metrics, mid), v]);
  return { id: run.id, passes: run.passes, impls, scenarios, metrics, stats, derived, withheld: run.withheld ?? {} };
}

export function unpackRun(p: PackedRun): RunSlice {
  const results: RunSlice['results'] = {};
  for (const row of p.stats) {
    const [i, s, k, m, lo, hi, min, max, n, cv] = row as [number, number, number, number, number | null, number | null, number, number, number, number];
    const impl = p.impls[i] as string;
    const scen = p.scenarios[s] as string;
    const metric = p.metrics[k] as string;
    ((results[impl] ??= {})[scen] ??= {})[metric] = { m, lo, hi, min, max, n, cv };
  }
  const derived: RunSlice['derived'] = {};
  for (const row of p.derived) {
    const [i, k, v] = row as [number, number, number];
    (derived[p.impls[i] as string] ??= {})[p.metrics[k] as string] = v;
  }
  return { id: p.id, passes: p.passes, results, derived, withheld: p.withheld ?? {} };
}

/** Serializes island props as one JSON string with the run packed (see PackedRun). */
export function encodeIslandProps(props: object): string {
  const { run, ...rest } = props as { run?: RunSlice };
  return JSON.stringify(run ? { ...rest, packedRun: packRun(run) } : rest);
}

export function decodeIslandProps<T>(payload: string): T {
  const parsed = JSON.parse(payload) as Record<string, unknown> & { packedRun?: PackedRun };
  const { packedRun, ...rest } = parsed;
  return (packedRun ? { ...rest, run: unpackRun(packedRun) } : rest) as T;
}
