/**
 * Checks against the real dataset in src/data/: the site must be able to render every domain the
 * index lists, every headline value must resolve or be explicitly missing, and nothing non-finite
 * may reach a page.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allDomains, getIndex, getProject, listDomains, rawDataFiles, validateDomain } from '../src/lib/dataset';
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

describe('project identity is never hardcoded', () => {
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

  it.each(files.map((f) => [f.slice(root.length + 1)]))('%s', (rel) => {
    const text = readFileSync(join(root, rel), 'utf8').toLowerCase();
    for (const needle of needles) expect(text.includes(needle.toLowerCase()), `contains "${needle}"`).toBe(false);
  });
});
