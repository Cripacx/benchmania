import { describe, expect, it } from 'vitest';
import {
  bundleUrl,
  byVisibility,
  communityRunsNote,
  communityStatus,
  compareBest,
  defaultRun,
  derivedExplanation,
  displayOrder,
  flagScenario,
  flagsFor,
  flagsForImplementation,
  groupMetricIds,
  implementationLinks,
  intervalsOverlap,
  licenseUrl,
  machineName,
  machineShortName,
  measuredMetricIds,
  metricGroups,
  metricValue,
  provenanceInfo,
  rankMap,
  relativeDiff,
  installCommand,
  installPrompt,
  repoPage,
  runImplementationIds,
  runLevelFlags,
  scenarioParams,
  sortIdsBy,
  suggestedComparisons,
  unmeasuredMetrics,
  unmeasuredScenarios,
} from '../src/lib/model';
import type { DomainData, Metric, Run } from '../src/lib/types';

const metric = (id: string, extra: Partial<Metric> = {}): Metric => ({
  id,
  label: id,
  unit: 'ms',
  better: 'lower',
  group: 'latency',
  decimals: 2,
  visibility: 'primary',
  ...extra,
});

const stat = (m: number, n = 1, lo = m, hi = m) => ({ m, lo, hi, min: lo, max: hi, n, cv: 0 });

function fixture(): DomainData {
  const run: Run = {
    id: 'r1',
    created: '2026-11-17T23:23:11Z',
    finished: '2026-11-18T00:27:52Z',
    status: 'complete',
    methodology: '1',
    provenance: 'reference',
    machine: 'm1',
    passes: 5,
    implementations: { a: { check: 'ok' }, b: { check: 'ok' }, c: { check: 'ok' } },
    results: {
      a: { s1: { rps: stat(100, 5, 95, 104), p99: stat(2.5, 5, 2.4, 2.7) } },
      b: { s1: { rps: stat(200, 5, 190, 210), p99: stat(2.5, 5, 2.3, 2.6) } },
      c: { s1: { rps: stat(100, 5, 99, 101) } },
    },
    derived: { a: { idx: 50 }, b: { idx: 100 } },
    flags: [
      { level: 'warning', scope: 'run', message: 'not enough physical cores' },
      { level: 'warning', scope: 'a/s1', message: '3 errors', pass: 2 },
      { level: 'info', scope: 'b/s1', message: 'throughput varies 12 % between passes' },
    ],
  };
  return {
    schema: 'benchcore.dataset/v1',
    domain: { id: 'd', title: 'Domain', summary: '', status: 'stable', headline: [{ metric: 'idx', label: 'Index' }] },
    metrics: {
      rps: metric('rps', { unit: 'req/s', better: 'higher', group: 'throughput', decimals: 0 }),
      p99: metric('p99'),
      cpu: metric('cpu', { unit: 'µs', group: 'cpu' }),
      diag: metric('diag', { visibility: 'diagnostic', group: 'quality' }),
      idx: metric('idx', { unit: 'index', better: 'higher', group: 'summary' }),
    },
    derived: [{ id: 'idx', kind: 'geomean_relative', metric: 'rps', scenarios: ['s1'] }],
    scenarios: [
      { id: 's2', title: 'Second', kind: 'rate', order: 20, params: { path: '/db', rate: 5000, connections: 64, duration: '20s', work: { select: 1 } } },
      { id: 's1', title: 'First', kind: 'http', order: 10, params: { method: 'POST', path: '/orders', body: 'orders.json' } },
    ],
    implementations: [
      { id: 'b', name: 'Bee', language: 'Go', category: 'micro', runtime: 'Go', framework: 'net/http' },
      { id: 'a', name: 'Aye', language: 'C#', category: 'framework', runtime: '.NET', framework: 'ASP.NET', variant: 'JIT', source: '../../sources/aspnet' },
      { id: 'c', name: 'Aye', language: 'C#', category: 'framework', runtime: '.NET', framework: 'ASP.NET', variant: 'AOT', source: '../../sources/aspnet' },
    ],
    machines: { m1: { id: 'm1', label: 'Box · 12 threads', reference: { label: 'Box · bare metal', operator: 'maintainers' } } },
    runs: [run],
    default_run: 'r1',
  };
}

describe('ranking', () => {
  it('uses competition ranking with ties', () => {
    const r = rankMap(
      [
        { id: 'a', value: 100 },
        { id: 'b', value: 200 },
        { id: 'c', value: 100 },
        { id: 'd', value: null },
      ],
      'higher',
    );
    expect(Object.fromEntries(r)).toEqual({ b: 1, a: 2, c: 2 });
  });

  it('ranks lower-is-better metrics ascending and does not rank neutral ones', () => {
    expect(rankMap([{ id: 'x', value: 3 }, { id: 'y', value: 1 }], 'lower').get('y')).toBe(1);
    expect(rankMap([{ id: 'x', value: 3 }], 'neutral').size).toBe(0);
  });

  it('sorts best first and keeps missing values last', () => {
    expect(compareBest(null, 5, 'higher')).toBeGreaterThan(0);
    const values: Record<string, number | null> = { a: 2, b: null, c: 9, d: 2 };
    expect(sortIdsBy(['a', 'b', 'c', 'd'], (id) => values[id], 'higher')).toEqual(['c', 'a', 'd', 'b']);
    expect(sortIdsBy(['a', 'b', 'c', 'd'], (id) => values[id], 'lower')).toEqual(['a', 'd', 'c', 'b']);
  });
});

describe('values and metrics', () => {
  const d = fixture();
  const run = d.runs[0]!;

  it('reads scenario stats and derived values', () => {
    expect(metricValue(run, 's1', 'rps', 'b')?.m).toBe(200);
    expect(metricValue(run, null, 'idx', 'b')).toEqual({ m: 100, derived: true });
    expect(metricValue(run, 's1', 'cpu', 'a')).toBeNull();
    expect(metricValue(run, null, 'idx', 'c')).toBeNull();
  });

  it('lists measured metrics in registry order and splits them by visibility', () => {
    expect(measuredMetricIds(d.metrics, run, 's1')).toEqual(['rps', 'p99']);
    expect(measuredMetricIds(d.metrics, run, null)).toEqual(['idx']);
    expect(byVisibility(d.metrics, ['rps', 'diag', 'unknown'])).toEqual({ primary: ['rps'], secondary: ['unknown'], diagnostic: ['diag'] });
  });

  it('reports primary metrics and scenarios that a run did not measure', () => {
    expect(unmeasuredMetrics(d, run).map((m) => m.id)).toEqual(['cpu']);
    expect(unmeasuredScenarios(d, run).map((s) => s.id)).toEqual(['s2']);
  });

  it('does not call an index "not measured" when it was withheld for everybody', () => {
    const withheld: Run = { ...run, derived: {}, withheld: { a: { idx: 'Throughput not measured in: s2' }, b: { idx: 'Throughput not measured in: s2' } } };
    expect(unmeasuredMetrics(d, withheld).map((m) => m.id)).toEqual(['cpu']);
    expect(unmeasuredMetrics(d, { ...run, derived: {} }).map((m) => m.id)).toEqual(['cpu', 'idx']);
  });

  it('shortens a machine name to what fits a select on a phone', () => {
    expect(machineShortName(d.machines.m1)).toBe('Box');
    expect(machineShortName({ id: 'x', label: 'Boat sandbox (cloud VM, 8 vCPU)' })).toBe('Boat sandbox');
    expect(machineShortName(undefined, 'abc')).toBe('abc');
  });

  it('keeps the domain order of implementations and finds the default run', () => {
    expect(runImplementationIds(d, run)).toEqual(['b', 'a', 'c']);
    expect(defaultRun(d)?.id).toBe('r1');
    expect(defaultRun({ ...d, default_run: 'missing' })?.id).toBe('r1');
  });

  it('orders metric groups by importance', () => {
    expect(metricGroups(d).map((g) => g.group)).toEqual(['summary', 'throughput', 'latency', 'cpu', 'quality']);
  });

  it('groups extra metrics by group importance and puts primary metrics first', () => {
    const reg: Record<string, Metric> = {
      steal: metric('steal', { group: 'quality', visibility: 'diagnostic' }),
      p50: metric('p50', { group: 'latency', visibility: 'secondary' }),
      p99: metric('p99', { group: 'latency' }),
      odd: metric('odd', { group: 'custom', visibility: 'secondary' }),
      errors: metric('errors', { group: 'throughput', visibility: 'secondary' }),
      rps: metric('rps', { group: 'throughput' }),
    };
    const ids = Object.keys(reg);
    expect(groupMetricIds(reg, ['steal', 'p50', 'odd', 'errors'])).toEqual([
      { group: 'throughput', ids: ['errors'] },
      { group: 'latency', ids: ['p50'] },
      { group: 'quality', ids: ['steal'] },
      { group: 'custom', ids: ['odd'] },
    ]);
    expect(displayOrder(reg, ids)).toEqual(['p99', 'rps', 'errors', 'p50', 'steal', 'odd']);
  });

  it('explains derived metrics from the data', () => {
    // Higher is better (throughput): the implementation's value divided by the best one.
    expect(derivedExplanation(d, 'idx')).toContain('In each of the declared scenarios (First): this implementation\'s “rps” divided by the best (highest) one');
    expect(derivedExplanation(d, 'idx')).toContain('geometric mean of those ratios times 100');
    expect(derivedExplanation(d, 'rps')).toBeNull();
    // Lower is better (time, CPU per request): the best value divided by the implementation's, as publish.derive does.
    const lower = { ...d, derived: [{ id: 'idx', kind: 'geomean_relative', metric: 'cpu', scenarios: ['s1', 's2'] }] };
    expect(lower.metrics.cpu?.better).toBe('lower');
    expect(derivedExplanation(lower, 'idx')).toContain('In each of the declared scenarios (First, Second): the best (lowest) “cpu” divided by this implementation\'s');
    const every = { ...d, derived: [{ id: 'idx', kind: 'geomean_relative', metric: 'cpu', scenarios: '*' as const }] };
    expect(derivedExplanation(every, 'idx')).toMatch(/^In every scenario: the best \(lowest\)/);
  });
});

describe('flags', () => {
  const run = fixture().runs[0]!;
  it('splits run-level and implementation flags', () => {
    expect(runLevelFlags(run).map((f) => f.message)).toEqual(['not enough physical cores']);
    expect(flagsForImplementation(run, 'a')).toHaveLength(1);
    expect(flagsFor(run, 'b', 's1')[0]?.level).toBe('info');
    expect(flagScenario(run.flags[1]!)).toBe('s1');
  });
});

describe('relative differences', () => {
  it('describes better and worse in the metric direction', () => {
    expect(relativeDiff(120, 100, 'higher')).toMatchObject({ tone: 'better', text: '+20 %' });
    expect(relativeDiff(80, 100, 'higher')).toMatchObject({ tone: 'worse', text: '−20 %' });
    expect(relativeDiff(80, 100, 'lower')).toMatchObject({ tone: 'better' });
    expect(relativeDiff(1.05, 1, 'lower')).toMatchObject({ tone: 'worse', text: '+5.0 %' });
  });

  it('switches to multiples for large differences', () => {
    expect(relativeDiff(424.5, 41.9, 'lower')).toMatchObject({ tone: 'worse', text: '10.1× higher' });
    expect(relativeDiff(0.26, 3.65, 'lower')).toMatchObject({ tone: 'better', text: '14.0× lower' });
  });

  it('handles equal, neutral and invalid inputs', () => {
    expect(relativeDiff(5, 5, 'higher')?.tone).toBe('same');
    // Below the displayed precision but not equal: keeps its direction, never "same".
    expect(relativeDiff(4999, 5000, 'higher')).toMatchObject({ tone: 'worse', text: '> −0.1 %' });
    expect(relativeDiff(5001, 5000, 'higher')).toMatchObject({ tone: 'better', text: '< +0.1 %' });
    expect(relativeDiff(5001, 5000, 'neutral')).toMatchObject({ tone: 'neutral', text: '< +0.1 %' });
    expect(relativeDiff(6, 5, 'neutral')?.tone).toBe('neutral');
    expect(relativeDiff(5, 0, 'higher')).toBeNull();
    expect(relativeDiff(null, 5, 'higher')).toBeNull();
  });

  it('detects overlapping intervals only when both have one', () => {
    const run = fixture().runs[0]!;
    expect(intervalsOverlap(metricValue(run, 's1', 'p99', 'a'), metricValue(run, 's1', 'p99', 'b'))).toBe(true);
    expect(intervalsOverlap(metricValue(run, 's1', 'rps', 'a'), metricValue(run, 's1', 'rps', 'b'))).toBe(false);
    expect(intervalsOverlap({ m: 1, lo: 1, hi: 1, n: 1 }, { m: 1, lo: 1, hi: 1, n: 1 })).toBeNull();
  });
});

describe('identity, machines and links', () => {
  const d = fixture();
  const project = { repository: 'https://example.org/owner/repo/' };

  it('prefers the reference label for machines', () => {
    expect(machineName(d.machines.m1)).toBe('Box · bare metal');
    expect(machineName({ id: 'x', label: 'Plain' })).toBe('Plain');
    expect(machineName(undefined, 'abc')).toBe('abc');
  });

  it('describes provenance', () => {
    expect(provenanceInfo('reference').label).toBe('Reference');
    expect(provenanceInfo('community').label).toBe('Community');
    expect(provenanceInfo(undefined).id).toBe('unknown');
  });

  it('counts runs by provenance and invites the first community run when there is none', () => {
    const impls = [{ id: 'a' }, { id: 'b' }] as DomainData['implementations'];
    const reference = [
      { machine: 'm1', provenance: 'reference' },
      { machine: 'm1', provenance: 'reference' },
    ] as Run[];
    const none = communityStatus([{ implementations: impls, runs: reference }]);
    expect(none).toEqual({
      runs: 2,
      reference: 2,
      community: 0,
      unlabelled: 0,
      machines: 1,
      communityMachines: 0,
      implementations: 2,
      domains: 1,
    });
    expect(communityRunsNote(none)).toBe('No community runs yet. Add the first.');

    const mixed = communityStatus([
      { implementations: impls, runs: [...reference, { machine: 'm2', provenance: 'community' } as Run] },
      {
        implementations: impls.slice(0, 1),
        runs: [{ machine: 'm3', provenance: 'community' }, { machine: 'm3', provenance: null }] as Run[],
      },
    ]);
    expect(mixed).toMatchObject({ runs: 5, reference: 2, community: 2, unlabelled: 1, machines: 3, communityMachines: 2, implementations: 3, domains: 2 });
    expect(communityRunsNote(mixed)).toBe('2 community runs from 2 machines so far.');
    expect(communityRunsNote({ community: 1, communityMachines: 1 })).toBe('1 community run from 1 machine so far.');
    expect(communityStatus([])).toMatchObject({ runs: 0, machines: 0, domains: 0 });
  });

  it('resolves source paths relative to the implementation directory', () => {
    const links = implementationLinks(project, 'backend', { id: 'dotnet10-aot', source: '../../sources/aspnet' });
    expect(links.directory).toBe('https://example.org/owner/repo/tree/main/domains/backend/implementations/dotnet10-aot');
    expect(links.source).toBe('https://example.org/owner/repo/tree/main/domains/backend/sources/aspnet');
    expect(implementationLinks(project, 'backend', { id: 'go' }).source).toBeNull();
  });

  it('links raw bundles and licenses', () => {
    expect(bundleUrl(project, 'backend', { id: 'r1', machine: 'm1' })).toBe(
      'https://example.org/owner/repo/blob/main/results/backend/m1/r1.json',
    );
    expect(licenseUrl('CC-BY-4.0')).toBe('https://spdx.org/licenses/CC-BY-4.0.html');
    expect(licenseUrl(undefined)).toBeNull();
    expect(repoPage(project, 'discussions')).toBe('https://example.org/owner/repo/discussions');
    expect(repoPage({ repository: 'https://example.org/owner/repo/' }, 'issues')).toBe('https://example.org/owner/repo/issues');
  });

  it('builds the one-line installer from the site URL', () => {
    expect(installCommand({ site_url: 'https://bench.example.org/' })).toBe('curl -fsSL https://bench.example.org/install.sh | sh');
    expect(installCommand({ site_url: '' })).toBeNull();
    expect(installCommand({})).toBeNull();
    expect(installCommand({ site_url: 'https://bench.example.org/' }, 'windows')).toBe('irm https://bench.example.org/install.ps1 | iex');
    expect(installCommand({ site_url: '' }, 'windows')).toBeNull();
  });

  it('builds the agent prompt from the name, slug and site URL', () => {
    expect(installPrompt({ name: 'Benchy', slug: 'benchy', site_url: 'https://bench.example.org//' })).toBe(
      'Install the Benchy CLI on this machine by following https://bench.example.org/install.md.\n' +
        'Then run `benchy doctor` and tell me whether this machine can run the benchmarks.',
    );
    expect(installPrompt({ name: 'Benchy', slug: 'benchy' })).toBeNull();
  });

  it('suggests comparisons of variants that share a source or runtime', () => {
    const s = suggestedComparisons(d, ['b', 'a', 'c']);
    expect(s[0]).toEqual({ title: 'ASP.NET: JIT vs AOT', ids: ['a', 'c'], note: null });
    expect(s).toHaveLength(1);
  });

  it('describes scenario parameters', () => {
    expect(scenarioParams(d.scenarios[0]!, d.scenarios)).toEqual([
      'GET /db',
      '5,000 req/s fixed',
      '64 connections',
      '20s measured',
      '1 SELECT per request',
    ]);
    expect(scenarioParams(d.scenarios[1]!)).toEqual(['POST /orders', 'body orders.json']);
  });
});
