/**
 * Build-time access to the dataset in src/data/. Server-side only: never import this module from a
 * client island, or the whole dataset ends up in the browser bundle. Islands receive the slices they
 * need as props.
 */
import type { DatasetIndex, DomainData, DomainSummary, Project } from './types';
import { RESERVED_SEGMENTS } from './paths';

const files = import.meta.glob<unknown>('../data/*.json', { eager: true, import: 'default' });
const rawFiles = import.meta.glob<string>('../data/*.json', { eager: true, query: '?raw', import: 'default' });

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function loadIndex(): DatasetIndex {
  const entry = Object.entries(files).find(([path]) => fileName(path) === 'index.json');
  if (!entry) throw new Error('src/data/index.json is missing. Run `publish` to generate the dataset.');
  return entry[1] as DatasetIndex;
}

const index = loadIndex();

export function getIndex(): DatasetIndex {
  return index;
}

export function getProject(): Project {
  return index.project;
}

/** Domains shown on the site: every domain in index.json that is not an example and has a data file. */
export function listDomains(): DomainSummary[] {
  return index.domains.filter((d) => d.status !== 'example' && hasDomainFile(d.id));
}

function hasDomainFile(id: string): boolean {
  return Object.keys(files).some((path) => fileName(path) === `${id}.json`);
}

const cache = new Map<string, DomainData>();

export function getDomain(id: string): DomainData {
  const cached = cache.get(id);
  if (cached) return cached;
  const entry = Object.entries(files).find(([path]) => fileName(path) === `${id}.json`);
  if (!entry) throw new Error(`src/data/${id}.json is missing but index.json lists domain "${id}".`);
  const data = entry[1] as DomainData;
  const problems = validateDomain(data);
  if (problems.length) throw new Error(`Dataset problem in src/data/${id}.json:\n- ${problems.join('\n- ')}`);
  cache.set(id, data);
  return data;
}

export function allDomains(): DomainData[] {
  return listDomains().map((d) => getDomain(d.id));
}

/** Structural checks the site depends on. Returns human-readable problems (empty when fine). */
export function validateDomain(data: DomainData): string[] {
  const problems: string[] = [];
  if (!data?.domain?.id) problems.push('domain.id is missing');
  if (!data.metrics || typeof data.metrics !== 'object') problems.push('metrics registry is missing');
  if (!Array.isArray(data.implementations)) problems.push('implementations must be a list');
  if (!Array.isArray(data.scenarios)) problems.push('scenarios must be a list');
  if (!Array.isArray(data.runs)) problems.push('runs must be a list');
  if (problems.length) return problems;
  const ids = new Set<string>();
  for (const impl of data.implementations) {
    if (ids.has(impl.id)) problems.push(`duplicate implementation id "${impl.id}"`);
    ids.add(impl.id);
    if (RESERVED_SEGMENTS.has(impl.id)) problems.push(`implementation id "${impl.id}" collides with a page route`);
  }
  for (const h of data.domain.headline ?? []) {
    if (!data.metrics[h.metric]) problems.push(`headline metric "${h.metric}" is not in the metric registry`);
    if (h.scenario && !data.scenarios.some((s) => s.id === h.scenario))
      problems.push(`headline scenario "${h.scenario}" is not a scenario of this domain`);
  }
  if (data.default_run && !data.runs.some((r) => r.id === data.default_run))
    problems.push(`default_run "${data.default_run}" is not in runs`);
  for (const run of data.runs) {
    if (!data.machines?.[run.machine]) problems.push(`run ${run.id} refers to unknown machine "${run.machine}"`);
  }
  return problems;
}

/** Raw bytes of the dataset files, for the download endpoints. */
export function rawDataFiles(): Array<{ name: string; content: string }> {
  const visible = new Set(['index.json', ...listDomains().map((d) => `${d.id}.json`)]);
  return Object.entries(rawFiles)
    .map(([path, content]) => ({ name: fileName(path), content }))
    .filter((f) => visible.has(f.name))
    .sort((a, b) => (a.name === 'index.json' ? -1 : b.name === 'index.json' ? 1 : a.name.localeCompare(b.name)));
}
