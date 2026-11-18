/**
 * Side-by-side comparison of 2–4 implementations in one run, with relative differences against a
 * baseline. Selection lives in the query string (?ids=a,b&baseline=a). Each implementation keeps its
 * color slot for as long as it is selected, so removing one never repaints the others.
 *
 * The headline cards stay visible; per-scenario detail is collapsed to one summary row per scenario
 * (its lead metric) and opened on demand. "Show all metrics" controls metric depth inside open scenarios.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatInterval, formatValue, MIN_CI_PASSES, plural } from '../../lib/format';
import {
  assessDiff,
  byVisibility,
  groupLabel,
  measuredMetricIds,
  metricOrFallback,
  metricValue,
  missingValue,
  relativeDiff,
  valueFlagTexts,
  type RelativeDiff,
} from '../../lib/model';
import { joinBase, routes } from '../../lib/paths';
import type { DerivedDefinition, Flag, HeadlineEntry, Metric, Scenario, Value } from '../../lib/types';
import type { ImplLite, RunSlice } from '../../lib/view';
import { BarChart } from './BarChart';
import { Icon } from './Icon';

interface Props {
  base: string;
  domainId: string;
  metrics: Record<string, Metric>;
  scenarios: Scenario[];
  impls: ImplLite[];
  run: RunSlice;
  headline: HeadlineEntry[];
  /** Implementation-scoped quality flags of the run; attached to values with valueFlags. */
  flags: Flag[];
  derived: DerivedDefinition[];
  /** Run scope of the page's links: null on the default-run routes. */
  scope: string | null;
  /** Implementations of the domain that this run does not contain: id to name. */
  notInRun: Record<string, string>;
  suggestions: Array<{ title: string; ids: string[] }>;
  maxCompare: number;
}

interface Entry {
  id: string;
  slot: number;
}

const SLOT_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

function freeSlot(entries: Entry[], max: number): number {
  for (let i = 0; i < max; i++) if (!entries.some((e) => e.slot === i)) return i;
  return entries.length % max;
}

function Delta({ diff, value, baseline }: { diff: RelativeDiff | null; value: Value | null; baseline: Value | null }) {
  if (!diff) return <span class="delta muted">no comparison</span>;
  // Assess first: only an exactly equal value is "same"; every other difference gets the interval wording.
  const a = assessDiff(diff, value, baseline);
  if (diff.tone === 'same') return <span class="delta tone-same">same</span>;
  return (
    <span class={`delta tone-${a.tone}${a.observed ? ' delta-observed' : ''}`} title={a.title}>
      {!a.observed && a.tone === 'better' && <Icon name="check" size={12} strokeWidth={2.25} />}
      {!a.observed && a.tone === 'worse' && <Icon name="x" size={12} strokeWidth={2.25} />}
      <span class="num">{diff.text}</span>
      {a.word && <span class="delta-word">{a.word}</span>}
      <span class="visually-hidden">. {a.title}</span>
    </span>
  );
}

export function Compare(props: Props) {
  const { base, domainId, metrics, scenarios, impls, run, headline, flags, derived, scope, notInRun, suggestions, maxCompare } = props;
  const max = Math.min(maxCompare, SLOT_COLORS.length);
  const ctx = useMemo(() => ({ derived, scenarios }), [derived, scenarios]);
  const flagsOf = (id: string, scenario: string | null, metric: string) => valueFlagTexts(ctx, flags, id, scenario, metric);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Open scenario sections, keyed by scenario id ('overall' for derived). Kept across selection changes.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Ids from ?ids= that could not be shown, so the page can say why instead of dropping them silently.
  const [skipped, setSkipped] = useState<{ notInRun: string[]; unknown: string[]; overMax: string[] }>({
    notInRun: [],
    unknown: [],
    overMax: [],
  });
  const ready = useRef(false);
  const implById = useMemo(() => new Map(impls.map((i) => [i.id, i])), [impls]);

  const fromIds = (ids: string[]): Entry[] =>
    ids
      .filter((id, i) => implById.has(id) && ids.indexOf(id) === i)
      .slice(0, max)
      .map((id, slot) => ({ id, slot }));

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
    const next = fromIds(ids);
    const unique = ids.filter((id, i) => ids.indexOf(id) === i);
    setSkipped({
      notInRun: unique.filter((id) => !implById.has(id) && id in notInRun),
      unknown: unique.filter((id) => !implById.has(id) && !(id in notInRun)),
      overMax: unique.filter((id) => implById.has(id)).slice(max),
    });
    setEntries(next);
    const b = q.get('baseline');
    setBaseline(b && next.some((e) => e.id === b) ? b : (next[0]?.id ?? null));
    ready.current = true;
    document.documentElement.classList.remove('cmp-pending');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready.current) return;
    const q = new URLSearchParams(window.location.search);
    if (entries.length) q.set('ids', entries.map((e) => e.id).join(','));
    else q.delete('ids');
    if (baseline && entries.length > 1 && baseline !== entries[0]?.id) q.set('baseline', baseline);
    else q.delete('baseline');
    const qs = q.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  }, [entries, baseline]);

  const add = (id: string) => {
    if (!id || entries.some((e) => e.id === id) || entries.length >= max) return;
    const next = [...entries, { id, slot: freeSlot(entries, max) }];
    setEntries(next);
    if (!baseline) setBaseline(id);
  };
  const remove = (id: string) => {
    const next = entries.filter((e) => e.id !== id);
    setEntries(next);
    if (baseline === id) setBaseline(next[0]?.id ?? null);
  };
  const choose = (ids: string[]) => {
    const next = fromIds(ids);
    setEntries(next);
    setBaseline(next[0]?.id ?? null);
  };

  const color = (id: string) => SLOT_COLORS[entries.find((e) => e.id === id)?.slot ?? 0] ?? SLOT_COLORS[0];
  const baseId = baseline && entries.some((e) => e.id === baseline) ? baseline : (entries[0]?.id ?? null);
  const baseImpl = baseId ? implById.get(baseId) : undefined;
  const nameOf = (id: string) => {
    const i = implById.get(id);
    return i ? `${i.name}${i.variant ? ` (${i.variant})` : ''}` : id;
  };
  const langs = [...new Set(impls.map((i) => i.language))].sort((a, b) => a.localeCompare(b));
  const hasOverall = Object.keys(run.derived ?? {}).length > 0;
  const sections: Array<{ key: string | null; title: string }> = [
    ...(hasOverall ? [{ key: null, title: 'Overall (derived)' }] : []),
    ...scenarios.map((s) => ({ key: s.id, title: s.title })),
  ];
  const sectionId = (key: string | null) => key ?? 'overall';
  /** The metric a collapsed scenario summarizes: its headline metric, else its first primary metric. */
  const leadMetric = (key: string | null, ids: string[]): string | null =>
    headline.find((h) => (h.scenario ?? null) === key && ids.includes(h.metric))?.metric ??
    byVisibility(metrics, ids).primary[0] ??
    ids[0] ??
    null;
  const allOpen = sections.length > 0 && sections.every((sec) => open[sectionId(sec.key)]);
  const setAll = (value: boolean) => setOpen(Object.fromEntries(sections.map((sec) => [sectionId(sec.key), value])));

  const notice =
    skipped.notInRun.length + skipped.unknown.length + skipped.overMax.length > 0 ? (
      <div class="notice notice-info cmp-skipped" role="note">
        <Icon name="info" />
        <div>
          {skipped.notInRun.length > 0 && (
            <p>Not measured in this run, so not shown: {skipped.notInRun.map((id) => notInRun[id] ?? id).join(', ')}.</p>
          )}
          {skipped.unknown.length > 0 && (
            <p>
              Unknown implementation {skipped.unknown.length === 1 ? 'id' : 'ids'} in the link, ignored:{' '}
              {skipped.unknown.map((id) => `“${id}”`).join(', ')}.
            </p>
          )}
          {skipped.overMax.length > 0 && (
            <p>
              At most {max} implementations can be compared; left out: {skipped.overMax.map(nameOf).join(', ')}.
            </p>
          )}
        </div>
      </div>
    ) : null;

  /** One table cell: value, flags and difference to the baseline. */
  const cell = (key: string | null, mid: string, id: string) => {
    const metric = metricOrFallback(metrics, mid);
    const v = metricValue(run, key, mid, id);
    const baseValue = baseId ? metricValue(run, key, mid, baseId) : null;
    const ci = formatInterval(v, metric);
    const f = flagsOf(id, key, mid);
    const missing = v ? null : missingValue(run, id, key, mid);
    return (
      <>
        <span class="cmp-val" title={ci ? `95 % CI ${ci}` : (missing?.reason ?? undefined)}>
          {v ? formatValue(v.m, metric) : <span class="muted">{missing?.label}</span>}
          {f.length > 0 && (
            <span class="chart-flag" title={f.join('\n')} aria-label={`Flagged: ${f.join('; ')}`}>
              <Icon name="alert" size={12} />
            </span>
          )}
        </span>
        {id === baseId ? (
          <span class="delta muted">baseline</span>
        ) : (
          v && <Delta diff={relativeDiff(v.m, baseValue?.m, metric.better)} value={v} baseline={baseValue} />
        )}
      </>
    );
  };

  const picker = (
    <div class="cmp-picker">
      <ul class="cmp-selected" aria-label="Selected implementations">
        {entries.map((e) => {
          const i = implById.get(e.id);
          return (
            <li key={e.id} class="cmp-pill">
              <span class="dot" style={{ background: SLOT_COLORS[e.slot] }} />
              <span>
                {i?.name ?? e.id}
                {i?.variant && <span class="muted"> · {i.variant}</span>}
              </span>
              {baseId === e.id && entries.length > 1 && <span class="tag">baseline</span>}
              <button type="button" class="cmp-remove" aria-label={`Remove ${nameOf(e.id)}`} onClick={() => remove(e.id)}>
                <Icon name="x" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      <div class="cmp-controls">
        <label class="field">
          <span>{entries.length >= max ? `Maximum of ${max} reached` : 'Add implementation'}</span>
          <span class="select">
            <select
              value=""
              disabled={entries.length >= max}
              onChange={(ev) => {
                add((ev.target as HTMLSelectElement).value);
                (ev.target as HTMLSelectElement).value = '';
              }}
            >
              <option value="">Choose…</option>
              {langs.map((lang) => (
                <optgroup key={lang} label={lang}>
                  {impls
                    .filter((i) => i.language === lang)
                    .map((i) => (
                      <option key={i.id} value={i.id} disabled={entries.some((e) => e.id === i.id)}>
                        {i.name}
                        {i.variant ? ` (${i.variant})` : ''}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </span>
        </label>
        {entries.length > 1 && (
          <label class="field">
            <span>Baseline</span>
            <span class="select">
              <select value={baseId ?? ''} onChange={(ev) => setBaseline((ev.target as HTMLSelectElement).value)}>
                {entries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {nameOf(e.id)}
                  </option>
                ))}
              </select>
            </span>
          </label>
        )}
      </div>
    </div>
  );

  if (entries.length < 2) {
    return (
      <div class="cmp">
        {notice}
        {picker}
        <div class="card card-pad cmp-empty">
          <h2>Pick at least two implementations</h2>
          <p class="text-2">
            Use the menu above, or start from one of these comparisons. Variants built from the same source isolate the
            effect of the runtime or compilation mode.
          </p>
          <ul class="cmp-suggestions">
            {suggestions.map((s) => (
              <li key={s.title}>
                <a
                  class="card card-link cmp-suggestion"
                  href={joinBase(base, routes.compare(domainId, s.ids, scope))}
                  onClick={(ev) => {
                    ev.preventDefault();
                    choose(s.ids);
                  }}
                >
                  <span class="cmp-suggestion-title">{s.title}</span>
                  <span class="muted">{s.ids.map(nameOf).join(' · ')}</span>
                  <Icon name="arrowRight" size={16} class="arrow" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div class="cmp">
      {notice}
      {picker}

      <section class="cmp-headline" aria-labelledby="cmp-headline-title">
        <h2 id="cmp-headline-title" class="visually-hidden">
          Headline metrics
        </h2>
        <div class="grid grid-2">
          {headline.map((h) => {
            const metric = metricOrFallback(metrics, h.metric);
            const data = entries.map((e) => {
              const i = implById.get(e.id);
              return {
                id: e.id,
                label: i?.name ?? e.id,
                sublabel: i?.variant ?? null,
                href: joinBase(base, routes.implementation(domainId, e.id, scope)),
                value: metricValue(run, h.scenario ?? null, h.metric, e.id),
                missing: missingValue(run, e.id, h.scenario ?? null, h.metric),
                color: color(e.id),
                flags: flagsOf(e.id, h.scenario ?? null, h.metric),
              };
            });
            const baseValue = baseId ? metricValue(run, h.scenario ?? null, h.metric, baseId) : null;
            const noValues = data.every((d) => !d.value);
            return (
              <article class="card card-pad cmp-card" key={`${h.scenario ?? ''}:${h.metric}`}>
                <header>
                  <h3>{h.label}</h3>
                  {h.hint && <p class="muted cmp-hint">{h.hint}</p>}
                </header>
                {noValues ? (
                  // No chart to draw: say per implementation (baseline included) why its value is missing.
                  <ul class="cmp-deltas cmp-missing" aria-label={`${h.label}: no values`}>
                    {data.map((d) => (
                      <li key={d.id}>
                        <span class="dot" style={{ background: d.color }} />
                        <span class="cmp-delta-name">
                          {nameOf(d.id)}
                          {d.id === baseId && <span class="muted"> · baseline</span>}
                        </span>
                        {d.flags.length > 0 && (
                          <span class="chart-flag" title={d.flags.join('\n')} aria-label={`Flagged: ${d.flags.join('; ')}`}>
                            <Icon name="alert" size={12} />
                          </span>
                        )}
                        <span class="delta muted" title={d.missing.reason}>
                          {d.missing.label === 'no index' ? d.missing.reason : 'Not measured in this run.'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <BarChart data={data} metric={metric} label={`${h.label}, ${metric.unit}`} dense />
                )}
                {!noValues && (
                <ul class="cmp-deltas">
                  {data
                    .filter((d) => d.id !== baseId)
                    .map((d) => {
                      const other = d.value;
                      return (
                        <li key={d.id}>
                          <span class="dot" style={{ background: d.color }} />
                          <span class="cmp-delta-name">{nameOf(d.id)}</span>
                          {other ? (
                            <Delta diff={relativeDiff(other.m, baseValue?.m, metric.better)} value={other} baseline={baseValue} />
                          ) : (
                            <span class="delta muted" title={d.missing.reason}>{d.missing.label}</span>
                          )}
                        </li>
                      );
                    })}
                </ul>
                )}
              </article>
            );
          })}
        </div>
        {baseImpl && (
          <p class="cmp-note muted">
            Differences are relative to {nameOf(baseImpl.id)}.{' '}
            {run.passes < MIN_CI_PASSES
              ? `With fewer than ${MIN_CI_PASSES} passes there is no 95 % interval, so every difference is an observed difference of the medians, marked “(observed)”; it may be noise (${plural(run.passes, 'pass', 'passes')} in this run).`
              : `Where both 95 % intervals overlap, the difference is marked “95 % intervals overlap”: this run does not separate the two. Derived values carry no interval, so their differences are marked “(observed)” (${plural(run.passes, 'pass', 'passes')} in this run).`}
          </p>
        )}
      </section>

      <section class="cmp-details" aria-labelledby="cmp-details-title">
        <div class="section-head">
          <div>
            <h2 id="cmp-details-title">Every scenario</h2>
            <p>One summary row per scenario. Open a scenario for its other metrics and the difference to the baseline.</p>
          </div>
          <div class="cmp-detail-tools">
            <button type="button" class="btn btn-secondary btn-sm" aria-pressed={allOpen} onClick={() => setAll(!allOpen)}>
              <Icon name={allOpen ? 'x' : 'chevronDown'} size={14} />
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
              <Icon name={showAll ? 'x' : 'plus'} size={14} />
              {showAll ? 'Primary metrics only' : 'Show all metrics'}
            </button>
          </div>
        </div>
        <div class="table-wrap cmp-table" tabIndex={0} role="region" aria-label="Comparison table">
          <table class="data">
            <thead>
              <tr>
                <th scope="col" class="cmp-sticky">
                  Scenario and metric
                </th>
                {entries.map((e) => (
                  <th scope="col" key={e.id} class="r">
                    <span class="cmp-col-head">
                      <span class="dot" style={{ background: color(e.id) }} />
                      {nameOf(e.id)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {sections.map((sec) => {
              const ids = measuredMetricIds(metrics, run, sec.key);
              const lead = leadMetric(sec.key, ids);
              if (!lead) return null;
              const vis = byVisibility(metrics, ids);
              const rest = (showAll ? ids : vis.primary).filter((mid) => mid !== lead);
              const sid = sectionId(sec.key);
              const isOpen = !!open[sid];
              const leadLabel = metricOrFallback(metrics, lead).label;
              return [
                <tbody key={`${sid}:head`}>
                  <tr class="cmp-group">
                    <th scope="row" class="cmp-sticky">
                      <button
                        type="button"
                        class="cmp-group-toggle"
                        aria-expanded={rest.length ? isOpen : undefined}
                        aria-controls={rest.length ? `cmp-sec-${sid}` : undefined}
                        disabled={!rest.length}
                        onClick={() => setOpen({ ...open, [sid]: !isOpen })}
                      >
                        <span class="cmp-chevron" aria-hidden="true">
                          {rest.length > 0 && <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />}
                        </span>
                        <span>
                          <span class="cmp-group-title">{sec.title}</span>
                          <span class="cmp-metric-sub">
                            {leadLabel}
                            {rest.length > 0 && ` · ${rest.length} more ${rest.length === 1 ? 'metric' : 'metrics'}`}
                          </span>
                        </span>
                      </button>
                    </th>
                    {entries.map((e) => (
                      <td key={e.id} class="r">
                        {cell(sec.key, lead, e.id)}
                      </td>
                    ))}
                  </tr>
                </tbody>,
                rest.length > 0 && (
                  <tbody key={`${sid}:rows`} id={`cmp-sec-${sid}`} hidden={!isOpen}>
                    {rest.map((mid) => {
                      const metric = metricOrFallback(metrics, mid);
                      return (
                        <tr key={mid}>
                          <th scope="row" class="cmp-sticky cmp-indent">
                            <span class="cmp-metric">{metric.label}</span>
                            {showAll && metric.visibility !== 'primary' && (
                              <span class="cmp-metric-sub">
                                {groupLabel(metric.group)} · {metric.visibility ?? 'secondary'}
                              </span>
                            )}
                          </th>
                          {entries.map((e) => (
                            <td key={e.id} class="r">
                              {cell(sec.key, mid, e.id)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                ),
              ];
            })}
          </table>
        </div>
      </section>
    </div>
  );
}
