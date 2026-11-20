/**
 * Checks against the real dataset in src/data/: the site must be able to render every domain the
 * index lists, every headline value must resolve or be explicitly missing, and nothing non-finite
 * may reach a page.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allDomains, getIndex, getProject, listDomains, presentationProblems, rawDataFiles, validateDomain } from '../src/lib/dataset';
import { MIN_CI_PASSES } from '../src/lib/format';
import { compareProps, explorerProps, leaderboardProps } from '../src/lib/islandProps';
import { methodologyInfo } from '../src/lib/methodology';
import { defaultRun, headlineValue, machineName, runImplementationIds } from '../src/lib/model';
import { decodeIslandProps, encodeIslandProps, packRun, runSlice, unpackRun } from '../src/lib/view';

const domains = allDomains();

describe('dataset index', () => {
  it('has a project identity', () => {
    const p = getProject();
    for (const key of ['name', 'slug', 'tagline', 'description', 'repository'] as const) expect(p[key]).toBeTruthy();
    expect(() => new URL(p.repository)).not.toThrow();
  });

  it('lists only non-example domains that have data files', () => {
    const listed = listDomains().map((d) => d.id);
    expect(listed.length).toBeGreaterThan(0);
    for (const d of getIndex().domains) if (d.status === 'example') expect(listed).not.toContain(d.id);
  });

  it('serves every visible dataset file byte for byte', () => {
    const names = rawDataFiles().map((f) => f.name);
    expect(names[0]).toBe('index.json');
    for (const d of listDomains()) expect(names).toContain(`${d.id}.json`);
  });
});

describe.each(domains.map((d) => [d.domain.id, d] as const))('domain %s', (_id, domain) => {
  it('passes structural validation', () => {
    expect(validateDomain(domain)).toEqual([]);
  });

  it('has a default run with results for every implementation it lists', () => {
    const run = defaultRun(domain);
    expect(run).toBeDefined();
    const ids = runImplementationIds(domain, run!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(Object.keys(run!.results[id] ?? {}).length).toBeGreaterThan(0);
  });

  it('contains only finite numbers in results and derived values', () => {
    for (const run of domain.runs) {
      for (const [impl, scen] of Object.entries(run.results))
        for (const [sid, metrics] of Object.entries(scen))
          for (const [mid, s] of Object.entries(metrics))
            for (const key of ['m', 'lo', 'hi', 'min', 'max', 'n', 'cv'] as const) {
              // The publisher reports no interval below MIN_CI_PASSES passes: lo and hi are then null, never a number.
              const noInterval = (key === 'lo' || key === 'hi') && s.n < MIN_CI_PASSES;
              const ok = noInterval ? s[key] === null : Number.isFinite(s[key]);
              expect(ok, `${run.id} ${impl}/${sid}/${mid}.${key} = ${s[key]} (n = ${s.n})`).toBe(true);
            }
      for (const values of Object.values(run.derived)) for (const v of Object.values(values)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('resolves headline values (or reports them as not measured)', () => {
    const run = defaultRun(domain)!;
    for (const h of domain.domain.headline) {
      const values = runImplementationIds(domain, run).map((id) => headlineValue(run, h, id));
      // At least one implementation must have each headline value, otherwise the headline is useless.
      expect(values.some((v) => v !== null), `${h.label}`).toBe(true);
    }
  });

  it('labels runs and machines', () => {
    for (const run of domain.runs) {
      expect(['reference', 'community']).toContain(run.provenance);
      expect(methodologyInfo(run.methodology).short).toBeTruthy();
      expect(machineName(domain.machines[run.machine], run.machine)).toBeTruthy();
    }
  });

  it('builds island props that survive serialization', () => {
    const run = defaultRun(domain)!;
    const base = '/repo/';
    const lb = leaderboardProps(domain, run, base);
    expect(lb.rows).toHaveLength(runImplementationIds(domain, run).length);
    for (const row of lb.rows) expect(row.href.startsWith(`${base}${domain.domain.id}/`)).toBe(true);

    const ex = explorerProps(domain, run, base, null);
    expect(ex.scope).toBeNull();
    expect(ex.initialMetric).toBeTruthy();
    const roundTrip = decodeIslandProps<typeof ex>(encodeIslandProps(ex));
    expect(roundTrip.run).toEqual(ex.run);
    expect(roundTrip.metrics).toEqual(ex.metrics);
    expect(JSON.stringify(roundTrip)).not.toMatch(/NaN|Infinity/);

    const cmp = compareProps(domain, run, base, null);
    expect(cmp.impls.length).toBe(lb.rows.length);
    // Scope follows the route, not the default status: the explicit route of the default run keeps its run id.
    expect(compareProps(domain, run, base, run.id).scope).toBe(run.id);
    expect(explorerProps(domain, run, base, run.id).scope).toBe(run.id);
  });

  it('packs run results losslessly', () => {
    for (const run of domain.runs) {
      const slice = runSlice(run);
      expect(unpackRun(packRun(slice))).toEqual(slice);
    }
  });

  it('keeps null intervals through packing (synthetic fixture)', () => {
    const slice = {
      id: 'fixture',
      passes: 2,
      results: { a: { s: { x: { m: 1, lo: null, hi: null, min: 0.9, max: 1.1, n: 2, cv: 0.1 } } } },
      derived: {},
      withheld: { a: { x_index: 'Throughput not measured in: s2' } },
    };
    expect(unpackRun(packRun(slice))).toEqual(slice);
  });

  it('drops min/max from a packed row only when they equal the interval', () => {
    const slice = {
      id: 'fixture',
      passes: 5,
      results: {
        a: {
          s: {
            same: { m: 1, lo: 0.9, hi: 1.1, min: 0.9, max: 1.1, n: 5, cv: 0.1 },
            wider: { m: 1, lo: 0.95, hi: 1.05, min: 0.9, max: 1.1, n: 5, cv: 0.1 },
          },
        },
      },
      derived: {},
      withheld: {},
    };
    const packed = packRun(slice);
    expect(packed.stats.map((r) => r.length)).toEqual([8, 10]);
    expect(unpackRun(packed)).toEqual(slice);
  });

  it('encodes props without a run unchanged', () => {
    const props = { columns: [{ key: 'k' }], caption: 'c' };
    expect(decodeIslandProps(encodeIslandProps(props))).toEqual(props);
  });
});

describe('presentation data contract (same as _presentation_problems in the engine)', () => {
  const ids = new Set(['x', 'y', 'z']);
  const check = (domain: Record<string, unknown>) => presentationProblems({ id: 'd', ...domain }, ids);
  it('accepts well-formed data, an empty ranking note and empty role names', () => {
    expect(
      check({
        ranking_note: 'Mixed revisions.',
        compare: [{ title: 'Pair', ids: ['x', 'y'], note: 'Fair.' }],
        methodology: { roles: { service: 'Tool', environment: '' }, checks: [{ check: 'c', effect: 'e' }], limitations: ['One.'], versions: { '1': 'First.' } },
      }),
    ).toEqual([]);
    expect(check({ ranking_note: '' })).toEqual([]);
  });

  it.each([
    [{ compare: [{ title: 'Nested', ids: [['x'], ['y']] }] }, 'two to four different'],
    [{ compare: [{ title: 'Repeated', ids: ['x', 'x'] }] }, 'two to four different'],
    [{ compare: [{ title: 'Too many', ids: ['x', 'y', 'z', 'w', 'v'] }] }, 'two to four different'],
    [{ compare: [{ title: 'Ghost', ids: ['x', 'ghost'] }] }, 'unknown implementation "ghost"'],
    [{ compare: [{ title: 3, ids: ['x', 'y'] }] }, 'needs a title'],
    [{ compare: [{ title: 'Pair', ids: ['x', 'y'], note: 4 }] }, 'note must be a string'],
    [{ compare: 'x,y' }, 'compare must be a list'],
    [{ compare: ['x'] }, 'must be an object'],
    [{ ranking_note: 7 }, 'ranking_note must be a string'],
    [{ methodology: 'text' }, 'methodology must be an object'],
    [{ methodology: { limitations: 'One sentence.' } }, 'limitations must be a list'],
    [{ methodology: { roles: { service: 1 } } }, 'roles.service must be a string'],
    [{ methodology: { checks: 'c' } }, 'checks must be a list'],
    [{ methodology: { checks: [{ check: 1, effect: 'e' }] } }, 'needs check and effect'],
    [{ methodology: { versions: { '1': 2 } } }, 'versions.1 must be a string'],
  ])('reports malformed data instead of throwing: %j', (domain, expected) => {
    expect(() => check(domain)).not.toThrow();
    expect(check(domain).join('\n')).toContain(expected);
  });

  it('is part of validateDomain', () => {
    const data = { domain: { id: 'd', headline: [], compare: [{ title: 'Nested', ids: [['x'], ['y']] }] }, metrics: {}, implementations: [], scenarios: [], runs: [] };
    expect(validateDomain(data as never).join('\n')).toContain('two to four different');
  });
});

describe('headline entries are validated before use', () => {
  const domainWith = (headline: unknown) => ({
    domain: { id: 'd', headline },
    metrics: { rps: { label: 'Throughput', unit: 'req/s', better: 'higher', group: 'throughput' } },
    implementations: [],
    scenarios: [{ id: 'json', title: 'JSON' }],
    runs: [],
  });
  const problems = (headline: unknown) => validateDomain(domainWith(headline) as never).join('\n');

  it('accepts well-formed entries, with and without the optional fields', () => {
    expect(problems([{ metric: 'rps', scenario: 'json', label: 'JSON', hint: 'Requests per second.' }, { metric: 'rps' }])).toBe('');
  });

  it.each([
    [[null], 'headline entry 1 must be an object'],
    [['rps'], 'headline entry 1 must be an object'],
    [[{ metric: 'rps' }, 7], 'headline entry 2 must be an object'],
    [[{ metric: ['rps'] }], 'headline entry 1: metric must be a string'],
    [[{ metric: { toString: null } }], 'headline entry 1: metric must be a string'],
    [[{ metric: 'ghost' }], 'headline metric "ghost" is not in the metric registry'],
    [[{ metric: 'toString' }], 'headline metric "toString" is not in the metric registry'],
    [[{ metric: 'rps', scenario: 'nope' }], 'headline scenario "nope"'],
    [[{ metric: 'rps', scenario: 3 }], 'headline entry 1: scenario must be a string'],
    [[{ metric: 'rps', scenario: { toString: null } }], 'headline entry 1: scenario must be a string'],
    [[{ metric: 'rps', label: 3 }], 'headline entry 1: label must be a string'],
    [[{ metric: 'rps', label: 'Throughput', hint: { text: 'x' } }], 'headline entry 1: hint must be a string'],
    ['rps', 'headline must be a list'],
  ])('reports a malformed entry instead of throwing: %j', (headline, expected) => {
    expect(() => validateDomain(domainWith(headline) as never)).not.toThrow();
    expect(problems(headline)).toContain(expected);
  });
});

describe('project identity, domains and implementations are never hardcoded', () => {
  const project = getProject();
  const root = join(__dirname, '..', 'src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'data') walk(p);
      } else if (/\.(astro|ts|tsx|css|mjs)$/.test(name)) files.push(p);
    }
  };
  walk(root);
  const needles = [project.name, project.repository, project.site_url].filter((x): x is string => !!x);
  // Domains and implementations come from the data too: their titles and names never appear in the source, and a
  // domain id never as a string literal or path segment (as a bare word it may be ordinary English).
  const dataNeedles = domains.flatMap((d) => [
    d.domain.title,
    ...d.implementations.map((i) => i.name),
    ...["'", '"', '`', '/'].map((q) => `${q}${d.domain.id}${q}`),
  ]);

  it.each(files.map((f) => [f.slice(root.length + 1)]))('%s', (rel) => {
    const text = readFileSync(join(root, rel), 'utf8').toLowerCase();
    for (const needle of needles) expect(text.includes(needle.toLowerCase()), `contains "${needle}"`).toBe(false);
    for (const needle of dataNeedles) expect(text.includes(needle.toLowerCase()), `contains "${needle}"`).toBe(false);
  });
});
