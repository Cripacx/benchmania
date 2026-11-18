import { describe, expect, it } from 'vitest';
import { assessDiff, derivedScale, missingValue, relativeDiff, runScope, flagNote, hasAlertFlags, highestFlagLevel, valueFlagNote, valueFlags, type ValueContext } from '../src/lib/model';
import type { DomainData, Flag, Run } from '../src/lib/types';

const ctx: ValueContext = {
  derived: [
    { id: 'throughput_index', kind: 'geomean_relative', metric: 'rps', scenarios: ['json', 'orders'] },
    { id: 'peak_memory_mib', kind: 'max', metric: 'mem', scenarios: '*' },
  ],
  scenarios: [
    { id: 'json', title: 'JSON' },
    { id: 'orders', title: 'Orders' },
    { id: 'cold', title: 'Cold load' },
  ],
};

const flags: Flag[] = [
  { level: 'warning', scope: 'run', message: 'not enough physical cores' },
  { level: 'info', scope: 'rust/orders', message: 'throughput varies 17 % between passes' },
  { level: 'info', scope: 'rust/cold', message: 'throughput varies 11 % between passes' },
  { level: 'error', scope: 'go', message: 'measurement failed', pass: 2 },
  { level: 'info', scope: 'go/json', message: '3 errors' },
];

describe('valueFlags', () => {
  it('attaches the flags of the scenarios a derived metric is computed from', () => {
    expect(valueFlags(ctx, flags, 'rust', null, 'throughput_index').map((f) => f.scope)).toEqual(['rust/orders']);
    expect(valueFlagNote(ctx, flags, 'rust', null, 'throughput_index')?.texts).toEqual(['Orders: throughput varies 17 % between passes']);
  });

  it('takes every scenario for "*" and for an unknown derived metric', () => {
    expect(valueFlags(ctx, flags, 'rust', null, 'peak_memory_mib').map((f) => f.scope)).toEqual(['rust/orders', 'rust/cold']);
    expect(valueFlags(ctx, flags, 'rust', null, 'unknown_index')).toHaveLength(2);
  });

  it('includes flags scoped to the whole implementation, for derived and scenario values', () => {
    expect(valueFlags(ctx, flags, 'go', null, 'throughput_index').map((f) => f.scope)).toEqual(['go', 'go/json']);
    expect(valueFlags(ctx, flags, 'go', 'orders', 'rps').map((f) => f.scope)).toEqual(['go']);
    expect(valueFlagNote(ctx, flags, 'go', 'orders', 'rps')?.texts).toEqual(['Whole measurement: measurement failed (pass 2)']);
  });

  it('keeps scenario values to their own scenario and never attaches run-level flags', () => {
    expect(valueFlags(ctx, flags, 'rust', 'json', 'rps')).toEqual([]);
    expect(valueFlags(ctx, flags, 'rust', 'cold', 'rps').map((f) => f.scope)).toEqual(['rust/cold']);
    expect(valueFlags(ctx, flags, 'nobody', null, 'throughput_index')).toEqual([]);
    expect(valueFlags(ctx, undefined, 'rust', null, 'throughput_index')).toEqual([]);
  });
});

describe('metric flags', () => {
  const note: Flag = { level: 'info', scope: 'rust/orders', metric: 'rps', message: 'throughput varies 16 % between passes' };
  const all = [...flags, note];
  const scopes = (scenario: string | null, metric: string) =>
    valueFlags(ctx, all, 'rust', scenario, metric).filter((f) => f.metric).map((f) => f.metric);

  it('reaches the scenario value of its own metric and the derived index computed from it', () => {
    expect(scopes('orders', 'rps')).toEqual(['rps']);
    expect(scopes(null, 'throughput_index')).toEqual(['rps']);
  });

  it('reaches nothing else', () => {
    expect(scopes('orders', 'mem')).toEqual([]);
    expect(scopes('orders', 'p99_ms')).toEqual([]);
    expect(scopes('json', 'rps')).toEqual([]);
    // Peak memory is computed from "mem" in every scenario, orders included.
    expect(scopes(null, 'peak_memory_mib')).toEqual([]);
    expect(scopes(null, 'unknown_index')).toEqual([]);
  });

  it('leaves flags without a metric attached to every value in scope', () => {
    expect(valueFlags(ctx, all, 'rust', 'orders', 'mem').map((f) => f.scope)).toEqual(['rust/orders']);
    expect(valueFlags(ctx, all, 'rust', null, 'peak_memory_mib').map((f) => f.scope)).toEqual(['rust/orders', 'rust/cold']);
  });
});

describe('flag severity', () => {
  const info: Flag = { level: 'info', scope: 'rust/orders', message: 'note' };
  const warning: Flag = { level: 'warning', scope: 'rust/orders', message: 'steal' };
  const error: Flag = { level: 'error', scope: 'rust', message: 'failed' };

  it('takes the most severe level of a list', () => {
    expect(highestFlagLevel([])).toBeNull();
    expect(highestFlagLevel([info, info])).toBe('info');
    expect(highestFlagLevel([info, warning])).toBe('warning');
    expect(highestFlagLevel([warning, error, info])).toBe('error');
    expect(highestFlagLevel([{ ...info, level: 'odd' }])).toBe('warning');
  });

  it('draws a quiet marker for info notes only and the alert for anything worse', () => {
    expect(flagNote(ctx, [])).toBeNull();
    expect(flagNote(ctx, [info])?.marker).toBe('info');
    expect(flagNote(ctx, [info, warning])).toEqual({ marker: 'alert', texts: ['Orders: note', 'Orders: steal'] });
    expect(flagNote(ctx, [error])?.marker).toBe('alert');
  });

  it('tags an implementation only for warnings and errors', () => {
    expect(hasAlertFlags([info, info])).toBe(false);
    expect(hasAlertFlags([info, warning])).toBe(true);
    expect(hasAlertFlags([error])).toBe(true);
    expect(hasAlertFlags([])).toBe(false);
  });
});

describe('missing values', () => {
  const run = { withheld: { php: { throughput_index: 'Error rate above 0.01 in: orders' } } };
  it('reads a withheld index as "no index" with the reason', () => {
    expect(missingValue(run, 'php', null, 'throughput_index')).toEqual({
      label: 'no index',
      reason: 'No index: Error rate above 0.01 in: orders.',
    });
  });
  it('reads everything else as not measured', () => {
    expect(missingValue(run, 'php', 'orders', 'throughput_index').label).toBe('not measured');
    expect(missingValue(run, 'go', null, 'throughput_index').label).toBe('not measured');
    expect(missingValue({}, 'go', null, 'throughput_index').label).toBe('not measured');
  });
  it('describes the scale of a relative index', () => {
    expect(derivedScale(ctx, 'throughput_index')).toBe('100 = best in all 2 scenarios');
    expect(derivedScale(ctx, 'peak_memory_mib')).toBeNull();
  });
});

describe('difference labels', () => {
  const withCi = (m: number, lo: number, hi: number) => ({ m, lo, hi, n: 5 });
  it('says the intervals overlap instead of claiming noise', () => {
    const a = assessDiff(relativeDiff(105, 100, 'higher')!, withCi(105, 98, 110), withCi(100, 96, 104));
    expect(a).toMatchObject({ tone: 'same', word: '95 % intervals overlap', observed: false });
  });
  it('calls a separated difference better or worse', () => {
    expect(assessDiff(relativeDiff(130, 100, 'higher')!, withCi(130, 125, 135), withCi(100, 96, 104))).toMatchObject({
      tone: 'better',
      word: 'better',
      observed: false,
    });
  });
  it('marks differences without an interval as observed', () => {
    const few = assessDiff(relativeDiff(80, 100, 'higher')!, { m: 80, lo: null, hi: null, n: 2 }, { m: 100, lo: null, hi: null, n: 2 });
    expect(few).toMatchObject({ tone: 'worse', word: 'worse (observed)', observed: true });
    expect(few.title).toContain('No 95 % interval (fewer than five passes)');
    const derived = assessDiff(relativeDiff(90, 50, 'higher')!, { m: 90, derived: true }, { m: 50, derived: true });
    expect(derived).toMatchObject({ word: 'better (observed)', observed: true });
    expect(derived.title).toContain('Derived values carry no interval');
  });
  it('labels close medians by their intervals, not as "same"', () => {
    // 0.02 % apart with tight, separate intervals: a real difference below the displayed precision.
    const separate = assessDiff(relativeDiff(5001, 5000, 'higher')!, withCi(5001, 5000.8, 5001.2), withCi(5000, 4999.8, 5000.2));
    expect(separate).toMatchObject({ tone: 'better', word: 'better', observed: false });
    expect(separate.title).toContain('< +0.1 %');
    // 0.02 % apart with overlapping intervals: says so instead of "same".
    const overlap = assessDiff(relativeDiff(4999, 5000, 'higher')!, withCi(4999, 4990, 5008), withCi(5000, 4991, 5009));
    expect(overlap).toMatchObject({ tone: 'same', word: '95 % intervals overlap', observed: false });
    // Without intervals: an observed difference.
    const few = assessDiff(relativeDiff(4999, 5000, 'higher')!, { m: 4999, lo: null, hi: null, n: 2 }, { m: 5000, lo: null, hi: null, n: 2 });
    expect(few).toMatchObject({ tone: 'worse', word: 'worse (observed)', observed: true });
  });
  it('calls only exactly equal values "same"', () => {
    const d = relativeDiff(5000, 5000, 'higher')!;
    expect(d).toMatchObject({ tone: 'same', text: 'same' });
    expect(assessDiff(d, withCi(5000, 4990, 5010), withCi(5000, 4995, 5005))).toMatchObject({ tone: 'same', word: '' });
  });
});

describe('run scope', () => {
  const run = (id: string) => ({ id }) as Run;
  const domain = { default_run: 'r2', runs: [run('r1'), run('r2')] } as unknown as DomainData;
  it('is null for the default run and the run id otherwise', () => {
    expect(runScope(domain, run('r2'))).toBeNull();
    expect(runScope(domain, run('r1'))).toBe('r1');
  });
});
