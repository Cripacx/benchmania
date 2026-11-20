import { describe, expect, it } from 'vitest';
import {
  DASH,
  formatBytes,
  formatAxisTicks,
  formatCompact,
  formatDate,
  formatDateTime,
  formatDuration,
  formatInterval,
  formatNumber,
  formatPercent,
  formatRange,
  formatValue,
  hasInterval,
  niceTicks,
  plural,
  unitSuffix,
} from '../src/lib/format';

const NNBSP = ' ';

describe('formatNumber', () => {
  it('uses the declared decimals and thousands separators', () => {
    expect(formatNumber(108897, 0)).toBe('108,897');
    expect(formatNumber(1.088458255936543, 2)).toBe('1.09');
    expect(formatNumber(21, 1)).toBe('21.0');
  });

  it('never shows a non-zero value as zero', () => {
    expect(formatNumber(0.00003, 4)).toBe('< 0.0001');
    expect(formatNumber(-0.004, 2)).toBe('> −0.01');
    expect(formatNumber(0, 2)).toBe('0.00');
  });

  it('uses a typographic minus and avoids negative zero', () => {
    expect(formatNumber(-12.5, 1)).toBe('−12.5');
    expect(formatNumber(-0.004, 0)).toBe('> −1');
  });

  it('renders non-finite and missing values as a dash, never NaN or Infinity', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) expect(formatNumber(v as number, 2)).toBe(DASH);
  });
});

describe('formatValue', () => {
  it('appends units with a narrow no-break space', () => {
    expect(formatValue(1.73, { unit: 'ms', decimals: 2 })).toBe(`1.73${NNBSP}ms`);
    expect(formatValue(21, { unit: 'MiB', decimals: 1 })).toBe(`21.0${NNBSP}MiB`);
  });

  it('keeps index and ratio values unitless', () => {
    expect(unitSuffix('index')).toBe('');
    expect(formatValue(98.66, { unit: 'index', decimals: 1 })).toBe('98.7');
    expect(formatValue(0.5771, { unit: 'ratio', decimals: 2 })).toBe('0.58');
  });

  it('can omit the unit', () => {
    expect(formatValue(126, { unit: 'ms', decimals: 0 }, { unit: false })).toBe('126');
  });
});

describe('intervals', () => {
  const metric = { unit: 'ms', decimals: 2 };
  it('has no interval for a single pass', () => {
    const v = { m: 6.93, lo: 6.93, hi: 6.93, min: 6.93, max: 6.93, n: 1, cv: 0 };
    expect(hasInterval(v)).toBe(false);
    expect(formatInterval(v, metric)).toBeNull();
    expect(formatRange(v, metric)).toBeNull();
  });

  it('formats a real interval and range', () => {
    const v = { m: 6.9, lo: 6.71, hi: 7.12, min: 6.6, max: 7.3, n: 5, cv: 0.03 };
    expect(hasInterval(v)).toBe(true);
    expect(formatInterval(v, metric)).toBe(`6.71–7.12${NNBSP}ms`);
    expect(formatInterval(v, metric, { unit: false })).toBe('6.71–7.12');
    expect(formatRange(v, metric)).toBe('6.60–7.30');
  });

  it('treats min..max of two passes as a range, not a confidence interval', () => {
    const v = { m: 6.9, lo: 6.7, hi: 7.1, min: 6.7, max: 7.1, n: 2, cv: 0.03 };
    expect(hasInterval(v)).toBe(false);
    expect(formatInterval(v, metric)).toBeNull();
    expect(formatRange(v, metric)).toBe('6.70–7.10');
  });

  it('accepts a null interval (current engine below three passes)', () => {
    const v = { m: 6.9, lo: null, hi: null, min: 6.7, max: 7.1, n: 2, cv: 0.03 };
    expect(hasInterval(v)).toBe(false);
    expect(formatInterval(v, metric)).toBeNull();
  });

  it('derived values never have an interval', () => {
    expect(hasInterval({ m: 98.66, derived: true, lo: 1, hi: 2, n: 5 })).toBe(false);
  });
});

describe('axis helpers', () => {
  it('produces nice ticks that cover the maximum', () => {
    expect(niceTicks(98.66)).toEqual({ ticks: [0, 25, 50, 75, 100], max: 100, step: 25 });
    expect(niceTicks(17.23).max).toBeGreaterThanOrEqual(17.23);
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], max: 1, step: 1 });
    const t = niceTicks(207419);
    expect(t.max).toBeGreaterThanOrEqual(207419);
    expect(t.ticks[0]).toBe(0);
  });

  it('formats compact tick labels', () => {
    expect(formatCompact(2500, 500)).toBe('2,500');
    expect(formatCompact(50000, 50000)).toBe('50K');
    expect(formatCompact(250000, 50000)).toBe('250K');
    expect(formatCompact(1500000)).toBe('1.5M');
    expect(formatCompact(0.5, 0.5)).toBe('0.5');
  });

  it('labels one axis on one scale', () => {
    expect(formatAxisTicks([0, 5000, 10000, 15000], 5000)).toEqual(['0', '5K', '10K', '15K']);
    expect(formatAxisTicks([0, 2500, 5000, 7500], 2500)).toEqual(['0', '2,500', '5,000', '7,500']);
    expect(formatAxisTicks([0, 2500, 5000, 7500, 10000, 12500], 2500)).toEqual(['0', '2.5K', '5K', '7.5K', '10K', '12.5K']);
    expect(formatAxisTicks([0, 0.5, 1], 0.5)).toEqual(['0.0', '0.5', '1.0']); // below 10K: formatCompact as before
  });
});

describe('other formatting', () => {
  it('formats bytes as decimal units like docker images', () => {
    expect(formatBytes(21800000)).toBe(`21.8${NNBSP}MB`);
    expect(formatBytes(1_200_000_000)).toBe(`1.20${NNBSP}GB`);
    expect(formatBytes(null)).toBe(DASH);
  });

  it('formats dates in UTC', () => {
    expect(formatDate('2026-11-17T23:23:11Z')).toBe('17 Nov 2026');
    expect(formatDateTime('2026-11-17T23:23:11Z')).toBe('17 Nov 2026, 23:23 UTC');
    expect(formatDate('not a date')).toBe(DASH);
    expect(formatDuration('2026-11-17T23:23:11Z', '2026-11-18T00:27:52Z')).toBe('1 h 5 min');
    expect(formatDuration('2026-11-17T23:23:11Z', null)).toBeNull();
  });

  it('pluralizes and formats percentages', () => {
    expect(plural(1, 'pass', 'passes')).toBe('1 pass');
    expect(plural(5, 'pass', 'passes')).toBe('5 passes');
    expect(plural(1500, 'run')).toBe('1,500 runs');
    expect(formatPercent(0.0123, 1)).toBe(`1.2${NNBSP}%`);
  });
});
