/**
 * Number, unit and date formatting. Pure functions, shared by server-rendered pages and islands.
 *
 * Rules:
 * - Values are shown with the number of decimals the metric registry declares, never fewer.
 * - A non-zero value that would round to zero is shown as "< 0.01" instead of a misleading "0.00".
 * - Non-finite values never reach the page: they render as an em dash.
 */
import type { Metric, Value } from './types';

const LOCALE = 'en-US';
/** Narrow no-break space between a number and its unit. */
export const UNIT_SPACE = ' ';
export const DASH = '—';
export const MINUS = '−';

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: min, maximumFractionDigits: max });
    nfCache.set(key, f);
  }
  return f;
}

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampDecimals(d: number | undefined): number {
  if (!isNum(d)) return 0;
  return Math.min(6, Math.max(0, Math.round(d)));
}

/** Formats with a typographic minus sign. */
function signed(text: string): string {
  return text.replace(/^-/, MINUS);
}

/** A number with exactly `decimals` fraction digits and thousands separators. */
export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (!isNum(value)) return DASH;
  const d = clampDecimals(decimals);
  const smallest = 10 ** -d;
  if (value !== 0 && Math.abs(value) < smallest / 2) {
    const bound = nf(d, d).format(smallest);
    return value > 0 ? `< ${bound}` : `> ${MINUS}${bound}`;
  }
  const text = nf(d, d).format(value);
  // "-0.00" after rounding a tiny negative number is not useful.
  return signed(text === `-${nf(d, d).format(0)}` ? nf(d, d).format(0) : text);
}

/** Units that read better without a visible suffix (the label already names them). */
const SILENT_UNITS = new Set(['index', 'ratio', '']);

export function unitSuffix(unit: string | undefined): string {
  if (!unit || SILENT_UNITS.has(unit)) return '';
  return unit;
}

/** Human-readable unit for headers, e.g. "req/s", "index", "ratio". */
export function unitLabel(metric: Pick<Metric, 'unit'>): string {
  return metric.unit || '';
}

export function formatValue(
  value: number | null | undefined,
  metric: Pick<Metric, 'unit' | 'decimals'>,
  options: { unit?: boolean } = {},
): string {
  const text = formatNumber(value, metric.decimals ?? 0);
  if (text === DASH || options.unit === false) return text;
  const unit = unitSuffix(metric.unit);
  return unit ? `${text}${UNIT_SPACE}${unit}` : text;
}

/**
 * Passes needed for a bootstrap interval. With fewer passes the engine stores min..max in lo/hi,
 * which is a range, not a confidence interval, so the site never labels it as one.
 */
export const MIN_CI_PASSES = 5;

/** True when the value carries a real interval (at least MIN_CI_PASSES passes and lo < hi). */
export function hasInterval(v: Value | null | undefined): v is Value & { lo: number; hi: number } {
  return !!v && !v.derived && isNum(v.lo) && isNum(v.hi) && (v.n ?? 0) >= MIN_CI_PASSES && v.hi > v.lo;
}

/** "12.1–13.4 ms" or null when there is no interval. */
export function formatInterval(
  v: Value | null | undefined,
  metric: Pick<Metric, 'unit' | 'decimals'>,
  options: { unit?: boolean } = {},
): string | null {
  if (!hasInterval(v)) return null;
  const d = metric.decimals ?? 0;
  const text = `${formatNumber(v.lo, d)}–${formatNumber(v.hi, d)}`;
  const unit = unitSuffix(metric.unit);
  return unit && options.unit !== false ? `${text}${UNIT_SPACE}${unit}` : text;
}

/** "min–max" range over passes, or null for a single pass. */
export function formatRange(v: Value | null | undefined, metric: Pick<Metric, 'unit' | 'decimals'>): string | null {
  if (!v || v.derived || !isNum(v.min) || !isNum(v.max) || (v.n ?? 0) < 2) return null;
  const d = metric.decimals ?? 0;
  return `${formatNumber(v.min, d)}–${formatNumber(v.max, d)}`;
}

export function formatPercent(ratio: number | null | undefined, decimals = 0): string {
  if (!isNum(ratio)) return DASH;
  return `${formatNumber(ratio * 100, decimals)}${UNIT_SPACE}%`;
}

/** Compact number for axis ticks: full under 10,000, then 25K / 1.5M. */
export function formatCompact(value: number, stepHint?: number): string {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  if (abs < 10_000) {
    const step = isNum(stepHint) && stepHint > 0 ? stepHint : abs || 1;
    const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
    return formatNumber(value, decimals);
  }
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      const decimals = Number.isInteger(Math.round(scaled * 10) / 10) && Math.round(scaled * 10) % 10 === 0 ? 0 : 1;
      return `${formatNumber(scaled, decimals)}${suffix}`;
    }
  }
  return formatNumber(value, 0);
}

/**
 * Labels for the ticks of one axis on one scale: when the largest tick is abbreviated (10K and up), every tick uses
 * its unit, so an axis reads "0, 5K, 10K, 15K", never "5,000" next to "10K".
 */
export function formatAxisTicks(ticks: number[], step?: number): string[] {
  const top = Math.max(0, ...ticks.filter(isNum).map(Math.abs));
  const unit = top >= 1e9 ? 1e9 : top >= 1e6 ? 1e6 : top >= 10_000 ? 1e3 : 1;
  if (unit === 1) return ticks.map((t) => formatCompact(t, step));
  const suffix = unit === 1e9 ? 'B' : unit === 1e6 ? 'M' : 'K';
  const scaledStep = isNum(step) && step > 0 ? step / unit : 1;
  // As many decimals as the step needs: 2.5K steps keep one, 5K steps none.
  let decimals = 0;
  while (decimals < 3 && Math.abs(Math.round(scaledStep * 10 ** decimals) - scaledStep * 10 ** decimals) > 1e-9) decimals++;
  const trim = (text: string) => (decimals > 0 ? text.replace(/\.?0+$/, '') : text);
  return ticks.map((t) => (t === 0 ? '0' : `${trim(formatNumber(t / unit, decimals))}${suffix}`));
}

/** Decimal megabytes like `docker images` (and the image_mb metric). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!isNum(bytes)) return DASH;
  if (bytes >= 1e9) return `${formatNumber(bytes / 1e9, 2)}${UNIT_SPACE}GB`;
  if (bytes >= 1e6) return `${formatNumber(bytes / 1e6, 1)}${UNIT_SPACE}MB`;
  if (bytes >= 1e3) return `${formatNumber(bytes / 1e3, 1)}${UNIT_SPACE}kB`;
  return `${formatNumber(bytes, 0)}${UNIT_SPACE}B`;
}

export function formatKiloBytes(bytes: number): string {
  return `${formatNumber(bytes / 1024, 1)}${UNIT_SPACE}KiB`;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

/** "17 Nov 2026" (UTC). */
export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? dateFmt.format(d) : DASH;
}

/** "17 Nov 2026, 23:23 UTC". */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  return d ? `${dateFmt.format(d)}, ${timeFmt.format(d)} UTC` : DASH;
}

/** "1 h 4 min" between two timestamps, or null if either is missing. */
export function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  const a = parseDate(startIso);
  const b = parseDate(endIso);
  if (!a || !b || b < a) return null;
  const minutes = Math.round((b.getTime() - a.getTime()) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(n, 0)} ${n === 1 ? singular : pluralForm}`;
}

/** Ticks from zero to a "nice" maximum that is >= max. */
export function niceTicks(max: number, target = 4): { ticks: number[]; max: number; step: number } {
  if (!isNum(max) || max <= 0) return { ticks: [0, 1], max: 1, step: 1 };
  const raw = max / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const candidates = [1, 2, 2.5, 5, 10];
  const norm = raw / mag;
  const pick = candidates.find((c) => c >= norm - 1e-12) ?? 10;
  const step = pick * mag;
  const niceMax = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i <= Math.round(niceMax / step); i++) ticks.push(Number((i * step).toPrecision(12)));
  return { ticks, max: niceMax, step };
}

/** Plain-language direction for a metric. */
export function betterText(better: Metric['better']): string {
  if (better === 'higher') return 'higher is better';
  if (better === 'lower') return 'lower is better';
  return 'context only (neither higher nor lower is better)';
}
