/**
 * Horizontal bar chart with confidence-interval whiskers.
 *
 * - Bars start at zero, are thin, with a rounded data end and a square baseline.
 * - One series (single color) unless a datum carries its own identity color (compare view).
 * - Values are direct-labeled in an aligned column; hover or keyboard focus shows a tooltip with
 *   median, interval, range, n and flags. The table view elsewhere carries the same numbers.
 */
import { useRef, useState } from 'preact/hooks';
import {
  formatCompact,
  formatInterval,
  formatNumber,
  formatRange,
  formatValue,
  hasInterval,
  isNum,
  MIN_CI_PASSES,
  niceTicks,
  unitSuffix,
} from '../../lib/format';
import type { FlagNote } from '../../lib/model';
import type { Metric, Value } from '../../lib/types';
import { Icon } from './Icon';
import { LangChip } from './LangChip';
import { useFlip } from './useFlip';

export interface BarDatum {
  id: string;
  label: string;
  sublabel?: string | null;
  href?: string;
  value: Value | null;
  /** Language of the implementation: a monogram chip when the datum has no series color. */
  language?: string | null;
  /** CSS color for identity encoding (compare view). Defaults to the single-series color. */
  color?: string;
  /** Quality flags behind the value (valueFlagNote); null when none. */
  flags?: FlagNote | null;
  rank?: number | null;
  /** How a missing value reads ("not measured", "no index") and why. */
  missing?: { label: string; reason: string };
}

interface Props {
  data: BarDatum[];
  metric: Metric;
  /** Accessible name of the chart, e.g. "Throughput in JSON, req/s". */
  label: string;
  dense?: boolean;
}

function describe(d: BarDatum, metric: Metric): string {
  const v = d.value;
  const has = !!v && isNum(v.m);
  const ci = has ? formatInterval(v, metric) : null;
  const parts = [
    d.rank ? `Rank ${d.rank}: ` : '',
    d.label,
    d.sublabel ? ` (${d.sublabel})` : '',
    ', ',
    has ? formatValue(v.m, metric) : (d.missing?.reason ?? 'not measured in this run'),
    ci ? `, 95 % interval ${ci}` : '',
    has && v.n ? `, ${v.n} ${v.n === 1 ? 'pass' : 'passes'}` : '',
    d.flags ? `. Flags: ${d.flags.texts.join('; ')}` : '',
  ];
  return parts.join('');
}

export function BarChart({ data, metric, label, dense = false }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const list = useRef<HTMLOListElement>(null);
  useFlip(list, data.map((d) => d.id).join(','));

  const extent = data.reduce((acc, d) => {
    const v = d.value;
    if (!v || !isNum(v.m)) return acc;
    return Math.max(acc, v.m, hasInterval(v) ? v.hi : v.m);
  }, 0);
  const { ticks, max, step } = niceTicks(extent, dense ? 3 : 4);
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / max) * 100))}%`;
  const unit = unitSuffix(metric.unit) || metric.unit;
  const active = data.find((d) => d.id === hover) ?? null;

  let tip = null;
  const activeValue = active?.value && isNum(active.value.m) ? active.value : null;
  if (active && (activeValue || active.missing)) {
    const li = rowRefs.current[active.id];
    const track = li?.querySelector<HTMLElement>('.chart-track');
    if (li && track) {
      const index = data.indexOf(active);
      const below = index < data.length / 2 || data.length < 4;
      const share = activeValue ? Math.max(0, Math.min(1, activeValue.m / max)) : 0;
      const x = li.offsetLeft + track.offsetLeft + track.offsetWidth * share;
      const y = below ? li.offsetTop + li.offsetHeight + 2 : li.offsetTop - 2;
      tip = <Tooltip datum={active} metric={metric} x={x} y={y} below={below} />;
    }
  }

  return (
    <div class={`chart ${dense ? 'chart-dense' : ''}`} onMouseLeave={() => setHover(null)}>
      <ol class="chart-rows" aria-label={label} ref={list}>
        {data.map((d) => {
          const v = d.value;
          const has = !!v && isNum(v.m);
          const interval = has && hasInterval(v) ? v : null;
          const description = describe(d, metric);
          return (
            <li
              key={d.id}
              data-flip={d.id}
              ref={(el) => {
                rowRefs.current[d.id] = el;
              }}
              class={`chart-row${hover === d.id ? ' is-hover' : ''}${has ? '' : ' is-missing'}`}
              onMouseEnter={() => setHover(d.id)}
            >
              {d.href ? (
                <a
                  class="chart-hit"
                  href={d.href}
                  aria-label={`${description}. Open details.`}
                  onFocus={() => setHover(d.id)}
                  onBlur={() => setHover((h) => (h === d.id ? null : h))}
                />
              ) : (
                <span class="visually-hidden">{description}</span>
              )}
              <div class="chart-label" aria-hidden="true">
                {d.color ? <span class="dot" style={{ background: d.color }} /> : d.language ? <LangChip language={d.language} /> : null}
                <span class="chart-name">
                  <span class="chart-title">{d.label}</span>
                  {d.sublabel && <span class="chart-sub">{d.sublabel}</span>}
                </span>
              </div>
              <div class="chart-track" aria-hidden="true">
                {ticks.slice(1).map((t) => (
                  <span key={t} class="chart-grid" style={{ left: pct(t) }} />
                ))}
                {has && (
                  <span
                    class="bar-fill"
                    style={{ width: pct(v.m), background: d.color ?? undefined, minWidth: v.m > 0 ? '2px' : '0' }}
                  />
                )}
                {interval && (
                  <span
                    class="whisker"
                    style={{ left: pct(interval.lo), width: `calc(${pct(interval.hi)} - ${pct(interval.lo)})` }}
                  />
                )}
              </div>
              <div class="chart-value" aria-hidden="true">
                {d.flags && (
                  <span class={`chart-flag is-${d.flags.marker}`} title={d.flags.texts.join('\n')}>
                    <Icon name={d.flags.marker} size={13} />
                  </span>
                )}
                {has ? formatNumber(v.m, metric.decimals ?? 0) : <span class="muted">{d.missing?.label ?? 'n/a'}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      <div class="chart-axis" aria-hidden="true">
        <div class="chart-axis-track">
          {ticks.map((t) => (
            <span key={t} class="chart-tick" style={{ left: pct(t) }}>
              {formatCompact(t, step)}
            </span>
          ))}
        </div>
        <div class="chart-axis-unit">{unit}</div>
      </div>
      {tip}
    </div>
  );
}

function Tooltip({ datum, metric, x, y, below }: { datum: BarDatum; metric: Metric; x: number; y: number; below: boolean }) {
  const v = datum.value;
  if (!v || !isNum(v.m))
    return (
      <div class={`chart-tip ${below ? 'is-below' : 'is-above'}`} aria-hidden="true" style={{ left: `${x}px`, top: `${y}px` }}>
        <div class="tip-value">{datum.missing?.label ?? 'not measured'}</div>
        <div class="tip-name">
          <span>
            {datum.label}
            {datum.sublabel ? ` · ${datum.sublabel}` : ''}
          </span>
        </div>
        {datum.missing && <p class="tip-reason">{datum.missing.reason}</p>}
      </div>
    );
  const ci = formatInterval(v, metric);
  const range = formatRange(v, metric);
  return (
    <div class={`chart-tip ${below ? 'is-below' : 'is-above'}`} aria-hidden="true" style={{ left: `${x}px`, top: `${y}px` }}>
      <div class="tip-value">{formatValue(v.m, metric)}</div>
      <div class="tip-name">
        {datum.color && <span class="tip-key" style={{ background: datum.color }} />}
        <span>
          {datum.label}
          {datum.sublabel ? ` · ${datum.sublabel}` : ''}
        </span>
      </div>
      <dl class="tip-stats">
        {datum.rank ? (
          <>
            <dt>Rank</dt>
            <dd>{datum.rank}</dd>
          </>
        ) : null}
        {v.derived ? (
          <>
            <dt>Source</dt>
            <dd>derived from medians</dd>
          </>
        ) : (
          <>
            <dt>95 % CI</dt>
            <dd>{ci ?? ((v.n ?? 0) < MIN_CI_PASSES ? `none (${v.n === 1 ? 'single pass' : `fewer than ${MIN_CI_PASSES} passes`})` : 'none')}</dd>
            {range && (
              <>
                <dt>Range</dt>
                <dd>{range}</dd>
              </>
            )}
            <dt>Passes</dt>
            <dd>{isNum(v.n) ? v.n : '—'}</dd>
            {isNum(v.cv) && (v.n ?? 0) >= 2 && (
              <>
                <dt>CV</dt>
                <dd>{formatNumber(v.cv * 100, 1)} %</dd>
              </>
            )}
          </>
        )}
      </dl>
      {datum.flags && (
        <ul class="tip-flags">
          {datum.flags.texts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
