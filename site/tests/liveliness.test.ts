import { describe, expect, it } from 'vitest';
import { languageChip, monogram } from '../src/lib/languages';
import { scenarioWinners } from '../src/lib/model';
import type { DomainData, Metric, Run } from '../src/lib/types';

const metric = (id: string, extra: Partial<Metric> = {}): Metric => ({
  id,
  label: id,
  unit: 'req/s',
  better: 'higher',
  group: 'throughput',
  decimals: 0,
  visibility: 'primary',
  ...extra,
});
const stat = (m: number) => ({ m, lo: m, hi: m, min: m, max: m, n: 5, cv: 0 });

function domain(run: Run): DomainData {
  return {
    domain: { id: 'd', title: 'D', summary: '' },
    metrics: { rps: metric('rps'), index: metric('index', { unit: 'index', group: 'summary' }) },
    derived: [
      { id: 'index', kind: 'geomean_relative', metric: 'rps', scenarios: ['json', 'db', 'list'] },
      { id: 'peak', kind: 'max', metric: 'rps', scenarios: '*' },
    ],
    scenarios: [
      { id: 'startup', title: 'Start', kind: 'startup', order: 1 },
      { id: 'db', title: 'Single query', kind: 'http', order: 3 },
      { id: 'json', title: 'JSON', kind: 'http', order: 2 },
      { id: 'list', title: 'List', kind: 'http', order: 4 },
    ],
    implementations: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), language: 'Go', category: 'micro' })),
    machines: {},
    runs: [run],
    default_run: run.id,
  } as unknown as DomainData;
}

function run(): Run {
  return {
    id: 'r',
    created: '2026-11-18T00:00:00Z',
    machine: 'm',
    passes: 5,
    results: {
      // a is the fastest in json, but the publisher did not make it the reference (its index is withheld).
      a: { json: { rps: stat(900) }, db: { rps: stat(100) } },
      b: { json: { rps: stat(500) }, db: { rps: stat(300) }, list: { rps: stat(40) } },
      c: { json: { rps: stat(500) }, db: { rps: stat(800) }, list: { rps: stat(50) } },
      d: { json: { rps: stat(200) }, db: { rps: stat(250) }, list: { rps: stat(0) } },
    },
    derived: { b: { index: 80 }, c: { index: 90 }, d: { peak: 250 } },
    withheld: { a: { index: 'Throughput not measured in: list' } },
    // What the publisher wrote: "db" is left out of the index (no entry), "ghost" is not in the run.
    best: {
      index: {
        list: { value: 50, by: ['c'] },
        json: { value: 500, by: ['b', 'c'] },
        orders: { value: 1, by: ['b'] },
      },
    },
    flags: [],
  } as unknown as Run;
}

describe('scenarioWinners', () => {
  const r = run();
  const winners = scenarioWinners(domain(r), r, 'index');

  it("shows the publisher's references only, in the domain's scenario order", () => {
    expect(winners.map((w) => w.scenario.id)).toEqual(['json', 'list']);
  });

  it('lists ties together and looks the value up for the first winner', () => {
    const json = winners.find((w) => w.scenario.id === 'json')!;
    expect(json.winners).toEqual(['b', 'c']);
    expect(json.value.m).toBe(500);
  });

  it('never re-derives: the fastest raw value does not win when the publisher did not crown it', () => {
    expect(winners.flatMap((w) => w.winners)).not.toContain('a');
  });

  it('counts as eligible the implementations that have the index', () => {
    expect(winners.every((w) => w.eligible === 2)).toBe(true);
  });

  it('keeps only winners that are part of the run', () => {
    const r2 = run();
    r2.best!.index!.json = { value: 500, by: ['ghost', 'c'] };
    expect(scenarioWinners(domain(r2), r2, 'index').find((w) => w.scenario.id === 'json')!.winners).toEqual(['c']);
    r2.best!.index!.json = { value: 500, by: ['ghost'] };
    expect(scenarioWinners(domain(r2), r2, 'index').map((w) => w.scenario.id)).toEqual(['list']);
  });

  it('yields nothing without a published reference', () => {
    const bare = { ...run(), best: undefined } as Run;
    expect(scenarioWinners(domain(bare), bare, 'index')).toEqual([]);
    expect(scenarioWinners(domain(r), r, 'peak')).toEqual([]);
    expect(scenarioWinners(domain(r), r, 'missing')).toEqual([]);
  });
});

describe('languageChip', () => {
  it('maps the known languages with readable colours', () => {
    for (const lang of ['Rust', 'Go', 'TypeScript', 'C#', 'Java', 'Python', 'PHP', 'Elixir']) {
      const chip = languageChip(lang);
      expect(chip.known).toBe(true);
      expect(chip.bg).toMatch(/^#[0-9a-f]{6}$/);
      expect(chip.mono.length).toBeGreaterThan(0);
      expect(chip.mono.length).toBeLessThanOrEqual(3);
    }
    expect(languageChip('rust').mono).toBe('Rs');
    expect(languageChip(' c# ').mono).toBe('C#');
    expect(languageChip('golang')).toEqual(languageChip('Go'));
  });

  it('falls back to a neutral chip with a monogram for an unknown language', () => {
    const chip = languageChip('Kotlin');
    expect(chip.known).toBe(false);
    expect(chip.mono).toBe('Ko');
    expect(chip.bg).toBe('var(--chip-bg)');
    expect(languageChip('Visual Basic').mono).toBe('VB');
    expect(languageChip('C++').mono).toBe('C++');
    expect(languageChip('Unknown').mono).toBe('?');
    expect(languageChip(undefined).mono).toBe('?');
    expect(languageChip('').known).toBe(false);
  });

  it('builds monograms of at most three characters', () => {
    expect(monogram('Zig')).toBe('Zig');
    expect(monogram('OCaml')).toBe('Oc');
    expect(monogram('  ')).toBe('?');
  });
});
