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
  // `label` is optional in domain.toml: without one, a headline entry is called by its metric's label.
  data.domain.headline = (data.domain.headline ?? []).map((h) => ({ ...h, label: h.label || data.metrics[h.metric]!.label }));
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
  problems.push(...headlineProblems(data.domain.headline, data.metrics, new Set(data.scenarios.map((s) => s?.id))));
  problems.push(...presentationProblems(data.domain, ids));
  if (data.default_run && !data.runs.some((r) => r.id === data.default_run))
    problems.push(`default_run "${data.default_run}" is not in runs`);
  for (const run of data.runs) {
    if (!data.machines?.[run.machine]) problems.push(`run ${run.id} refers to unknown machine "${run.machine}"`);
  }
  return problems;
}

const isText = (v: unknown, empty = false): v is string => typeof v === 'string' && (empty || v.trim() !== '');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Headline entries, checked like `_headline_problems` in core/benchcore/manifest.py before anything dereferences
 * them: each is an object whose `metric` (and optional `scenario`) name a metric and scenario of the domain, with
 * `label` and `hint` as strings when given. Reports problems, never throws.
 */
export function headlineProblems(headline: unknown, metrics: unknown, scenarioIds: Set<string>): string[] {
  if (headline === undefined) return [];
  if (!Array.isArray(headline)) return ['headline must be a list'];
  const problems: string[] = [];
  headline.forEach((h: unknown, n) => {
    const where = `headline entry ${n + 1}`;
    if (!isRecord(h)) return problems.push(`${where} must be an object with a metric`);
    // The type is checked before a value is put into a message: String() throws on some JSON values.
    if (typeof h.metric !== 'string') problems.push(`${where}: metric must be a string`);
    else if (!isRecord(metrics) || !Object.hasOwn(metrics, h.metric))
      problems.push(`headline metric "${h.metric}" is not in the metric registry`);
    if (h.scenario !== undefined && h.scenario !== null) {
      if (typeof h.scenario !== 'string') problems.push(`${where}: scenario must be a string`);
      else if (!scenarioIds.has(h.scenario)) problems.push(`headline scenario "${h.scenario}" is not a scenario of this domain`);
    }
    if (h.label !== undefined && !isText(h.label)) problems.push(`${where}: label must be a string`);
    if (h.hint !== undefined && !isText(h.hint, true)) problems.push(`${where}: hint must be a string`);
  });
  return problems;
}

/**
 * What the site prints from a domain's presentation data, checked like `_presentation_problems` in
 * core/benchcore/manifest.py: containers before they are iterated, strings wherever text is printed, and comparisons
 * of two to four distinct implementation ids. Reports problems, never throws.
 */
export function presentationProblems(domain: unknown, implementationIds: Set<string>): string[] {
  const problems: string[] = [];
  if (!isRecord(domain)) return ['domain must be an object'];
  const note = domain.ranking_note;
  if (note !== undefined && note !== '' && !isText(note)) problems.push('ranking_note must be a string');
  const compare = domain.compare ?? [];
  if (!Array.isArray(compare)) problems.push('compare must be a list');
  else
    compare.forEach((c: unknown, n) => {
      const where = `comparison ${n + 1}`;
      if (!isRecord(c)) return problems.push(`${where} must be an object with title and ids`);
      if (!isText(c.title)) problems.push(`${where} needs a title (a string)`);
      if (c.note !== undefined && c.note !== null && !isText(c.note)) problems.push(`${where}: note must be a string`);
      const members = c.ids;
      if (
        !Array.isArray(members) ||
        !members.every((i) => typeof i === 'string') ||
        members.length < 2 ||
        members.length > 4 ||
        new Set(members).size !== members.length
      )
        problems.push(`${where} needs ids with two to four different implementations`);
      else for (const i of members) if (!implementationIds.has(i)) problems.push(`${where} names unknown implementation "${i}"`);
    });
  const m = domain.methodology ?? {};
  if (!isRecord(m)) return [...problems, 'methodology must be an object'];
  if (m.document !== undefined && typeof m.document !== 'string') problems.push('methodology.document must be a string');
  const roles = m.roles ?? {};
  if (!isRecord(roles)) problems.push('methodology.roles must be an object');
  else for (const [r, name] of Object.entries(roles)) if (!isText(name, true)) problems.push(`methodology.roles.${r} must be a string`);
  const checks = m.checks ?? [];
  if (!Array.isArray(checks)) problems.push('methodology.checks must be a list');
  else
    checks.forEach((c: unknown, n) => {
      if (!isRecord(c) || !isText(c.check) || !isText(c.effect)) problems.push(`methodology check ${n + 1} needs check and effect (strings)`);
    });
  const limitations = m.limitations ?? [];
  if (!Array.isArray(limitations) || !limitations.every((x) => isText(x))) problems.push('methodology.limitations must be a list of sentences');
  const versions = m.versions ?? {};
  if (!isRecord(versions)) problems.push('methodology.versions must be an object');
  else for (const [v, text] of Object.entries(versions)) if (!isText(text)) problems.push(`methodology.versions.${v} must be a string`);
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
