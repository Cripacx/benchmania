/**
 * Domain explorer: scenario selector, metric selector (primary first, "all metrics" on demand),
 * bar chart with interval whiskers or a table, and a selection of implementations to compare.
 * State is mirrored in the query string so every view can be linked.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { betterText, formatInterval, formatNumber, formatRange, hasInterval, isNum, MIN_CI_PASSES, plural } from '../../lib/format';
import {
  byVisibility,
  categoryLabel,
  groupLabel,
  groupMetricIds,
  measuredMetricIds,
  metricOrFallback,
  metricValue,
  missingValue,
  rankMap,
  scenarioKindLabel,
  scenarioParams,
  sortIdsBy,
  valueFlagNote,
  implLabel,
  withheldLines,
} from '../../lib/model';
import { joinBase, routes } from '../../lib/paths';
import type { DerivedDefinition, Flag, HeadlineEntry, Metric, Scenario } from '../../lib/types';
import type { ImplLite, RunOption, RunSlice } from '../../lib/view';
import { BarChart, type BarDatum } from './BarChart';
import { Icon } from './Icon';
import { LangChip } from './LangChip';
import { WithheldNotes } from './WithheldNotes';

/** Pseudo-scenario for derived metrics. */
export const OVERALL = 'overall';

interface Props {
  base: string;
  domainId: string;
  metrics: Record<string, Metric>;
  scenarios: Scenario[];
  impls: ImplLite[];
  run: RunSlice;
  headline: HeadlineEntry[];
  derivedNotes: Record<string, string>;
  /** The domain's caveat shown directly above the chart or table (`ranking_note`); empty: none. */
  rankingNote: string;
  /** Implementation-scoped quality flags of the run; attached to values with valueFlags. */
  flags: Flag[];
  derived: DerivedDefinition[];
  /** Scale of each relative index in this run (derivedScales). */
  scales: Record<string, string>;
  /** Run scope of the page's links: null on the default-run routes, else the run id. */
  scope: string | null;
  runOptions: RunOption[];
  initialScenario: string;
  initialMetric: string;
  maxCompare: number;
}

type View = 'chart' | 'table';

export function Explorer(props: Props) {
  const { base, domainId, metrics, scenarios, impls, run, headline, derivedNotes, rankingNote, flags, derived, scales, scope, runOptions, maxCompare } = props;
  const ctx = useMemo(() => ({ derived, scenarios }), [derived, scenarios]);

  const hasOverall = useMemo(() => measuredMetricIds(metrics, run, null).length > 0, [metrics, run]);
  const scenarioIds = useMemo(() => [...(hasOverall ? [OVERALL] : []), ...scenarios.map((s) => s.id)], [hasOverall, scenarios]);

  const [scenario, setScenario] = useState(props.initialScenario);
  const [metric, setMetric] = useState(props.initialMetric);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<View>('chart');
  const [selected, setSelected] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const ready = useRef(false);

  const scenarioKey = scenario === OVERALL ? null : scenario;
  const metricIds = useMemo(() => measuredMetricIds(metrics, run, scenarioKey), [metrics, run, scenarioKey]);
  const groups = useMemo(() => byVisibility(metrics, metricIds), [metrics, metricIds]);

  const defaultMetricFor = (sid: string): string => {
    const key = sid === OVERALL ? null : sid;
    const ids = measuredMetricIds(metrics, run, key);
    const h = headline.find((e) => (e.scenario ?? null) === key && ids.includes(e.metric));
    if (h) return h.metric;
    const vis = byVisibility(metrics, ids);
    return vis.primary[0] ?? vis.secondary[0] ?? ids[0] ?? '';
  };

  // Read the query string once after hydration.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get('scenario');
    const nextScenario = s && scenarioIds.includes(s) ? s : scenario;
    const ids = measuredMetricIds(metrics, run, nextScenario === OVERALL ? null : nextScenario);
    const m = q.get('metric');
    const nextMetric = m && ids.includes(m) ? m : nextScenario !== scenario ? defaultMetricFor(nextScenario) : metric;
    if (nextScenario !== scenario) setScenario(nextScenario);
    if (nextMetric !== metric) setMetric(nextMetric);
    if (m && ids.includes(m) && metrics[m] && metrics[m]?.visibility !== 'primary') setShowAll(true);
    const v = q.get('view');
    if (v === 'table') setView('table');
    const sel = q.get('ids');
    if (sel) {
      const valid = sel.split(',').filter((id) => impls.some((i) => i.id === id));
      if (valid.length) setSelected(valid);
    }
    ready.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror state into the query string.
  useEffect(() => {
    if (!ready.current) return;
    const q = new URLSearchParams(window.location.search);
    q.set('scenario', scenario);
    q.set('metric', metric);
    if (view === 'table') q.set('view', 'table');
    else q.delete('view');
    if (selected && selected.length) q.set('ids', selected.join(','));
    else q.delete('ids');
    const url = `${window.location.pathname}?${q.toString()}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  }, [scenario, metric, view, selected]);

  const chooseScenario = (sid: string) => {
    setScenario(sid);
    const ids = measuredMetricIds(metrics, run, sid === OVERALL ? null : sid);
    if (!ids.includes(metric)) setMetric(defaultMetricFor(sid));
  };

  const m = metricOrFallback(metrics, metric);
  const scen = scenarios.find((s) => s.id === scenario) ?? null;
  const visibleImpls = selected ? impls.filter((i) => selected.includes(i.id)) : impls;

  const value = (id: string) => metricValue(run, scenarioKey, metric, id);
  const ranks = useMemo(
    () => rankMap(impls.map((i) => ({ id: i.id, value: metricValue(run, scenarioKey, metric, i.id)?.m ?? null })), m.better),
    [impls, run, scenarioKey, metric, m.better],
  );
  const order = sortIdsBy(
    visibleImpls.map((i) => i.id),
    (id) => value(id)?.m ?? null,
    m.better,
  );
  const implById = new Map(impls.map((i) => [i.id, i]));
  const data: BarDatum[] = order.map((id) => {
    const impl = implById.get(id)!;
    return {
      id,
      label: impl.name,
      language: impl.language,
      sublabel: impl.variant,
      href: joinBase(base, routes.implementation(domainId, id, scope)),
      value: value(id),
      flags: valueFlagNote(ctx, flags, id, scenarioKey, metric),
      missing: missingValue(run, id, scenarioKey, metric),
      rank: ranks.get(id) ?? null,
    };
  });
  const measuredCount = data.filter((d) => d.value).length;
  const labelOf = (id: string) => {
    const i = implById.get(id);
    return i ? implLabel(i) : id;
  };
  const withheld = scenarioKey ? [] : withheldLines(run, order, metric, labelOf, undefined, visibleImpls.length === impls.length);
  const anyInterval = data.some((d) => hasInterval(d.value));
  const maxN = data.reduce((acc, d) => Math.max(acc, d.value?.n ?? 0), 0);

  const scenarioTitle = scenario === OVERALL ? 'Overall' : (scen?.title ?? scenario);
  const chartLabel = `${m.label} in ${scenarioTitle}${m.unit ? `, ${m.unit}` : ''}, ${betterText(m.better)}`;

  const compareIds = selected && selected.length >= 2 && selected.length <= maxCompare ? selected : null;
  const compareHref = joinBase(base, routes.compare(domainId, compareIds ?? [], scope));

  const extraCount = groups.secondary.length + groups.diagnostic.length;
  const extraGroups = useMemo(() => groupMetricIds(metrics, [...groups.secondary, ...groups.diagnostic]), [groups, metrics]);

  return (
    <div class="explorer">
      <aside class="ex-side" aria-label="Scenarios">
        <div class="ex-side-mobile">
          <label class="field">
            <span>Scenario</span>
            <span class="select">
              <select value={scenario} onChange={(e) => chooseScenario((e.target as HTMLSelectElement).value)}>
                {hasOverall && <option value={OVERALL}>Overall (derived)</option>}
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
        <ul class="ex-scenarios">
          {hasOverall && (
            <li>
              <button
                type="button"
                class="ex-scenario"
                aria-pressed={scenario === OVERALL}
                onClick={() => chooseScenario(OVERALL)}
              >
                <span class="ex-scenario-title">Overall</span>
                <span class="ex-scenario-kind">Derived</span>
              </button>
            </li>
          )}
          {scenarios.map((s) => (
            <li key={s.id}>
              <button type="button" class="ex-scenario" aria-pressed={scenario === s.id} onClick={() => chooseScenario(s.id)}>
                <span class="ex-scenario-title">{s.title}</span>
                <span class="ex-scenario-kind">{scenarioKindLabel(s.kind)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section class="ex-main">
        {runOptions.length > 1 && <RunSwitcher options={runOptions} current={run.id} />}
        <p class="visually-hidden" aria-live="polite">
          {`Showing ${chartLabel}`}
        </p>
        <header class="ex-head">
          <div class="ex-head-text">
            <p class="eyebrow">{scenario === OVERALL ? 'Derived from several scenarios' : scenarioKindLabel(scen?.kind ?? '')}</p>
            <h2>{scenarioTitle}</h2>
            <p class="ex-desc">
              {scenario === OVERALL
                ? 'Summary metrics computed from the scenario medians of this run.'
                : (scen?.description ?? '')}
            </p>
            {scen && scenarioParams(scen, scenarios).length > 0 && (
              <ul class="ex-params" aria-label="Scenario parameters">
                {scenarioParams(scen, scenarios).map((p) => (
                  <li key={p} class="tag">
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </header>

        <div class="ex-metrics">
          <div class="chips" role="group" aria-label="Metric">
            {groups.primary.map((id) => (
              <button key={id} type="button" class="chip" aria-pressed={metric === id} onClick={() => setMetric(id)}>
                {metrics[id]?.label ?? id}
              </button>
            ))}
            {groups.primary.length === 0 && <span class="muted">No primary metric in this scenario.</span>}
            {extraCount > 0 && (
              <button
                type="button"
                class="btn btn-ghost btn-sm ex-more"
                aria-expanded={showAll}
                aria-controls="ex-all-metrics"
                onClick={() => setShowAll(!showAll)}
              >
                <Icon name={showAll ? 'x' : 'plus'} size={14} />
                {showAll ? 'Fewer metrics' : `All metrics (${extraCount} more)`}
              </button>
            )}
          </div>
          {showAll && extraCount > 0 && (
            <div class="ex-all" id="ex-all-metrics">
              {extraGroups.map(({ group: g, ids }) => (
                <div class="ex-group" key={g}>
                  <span class="ex-group-label">{groupLabel(g)}</span>
                  <div class="chips">
                    {ids.map((id) => (
                      <button
                        key={id}
                        type="button"
                        class={`chip chip-sm${metrics[id]?.visibility === 'diagnostic' ? ' chip-diag' : ''}`}
                        aria-pressed={metric === id}
                        onClick={() => setMetric(id)}
                      >
                        {metrics[id]?.label ?? id}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class="card ex-card">
          <div class="ex-card-head">
            <div class="ex-metric-info">
              <h3>
                {m.label}
                {m.unit && m.unit !== 'index' && <span class="ex-unit"> · {m.unit}</span>}
              </h3>
              <p class="ex-metric-desc">
                <span class="dir">
                  {m.better === 'higher' && <Icon name="arrowUp" size={12} strokeWidth={2} />}
                  {m.better === 'lower' && <Icon name="arrowDown" size={12} strokeWidth={2} />}
                  {betterText(m.better)}
                </span>
                {/* A derived metric: its scale here, how it is computed behind the disclosure below (said once). */}
                {derivedNotes[metric]
                  ? scales[metric] && <span> · {scales[metric]}</span>
                  : m.description && <span> · {m.description}</span>}
              </p>
              {derivedNotes[metric] && (
                <details class="ex-derivation">
                  <summary>How it is computed</summary>
                  <p>{derivedNotes[metric]}</p>
                  {m.description && <p>{m.description}</p>}
                </details>
              )}
            </div>
            <div class="ex-card-tools">
              <div class="ex-picker">
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  aria-expanded={pickerOpen}
                  aria-controls="ex-picker-panel"
                  onClick={() => setPickerOpen(!pickerOpen)}
                >
                  <Icon name="sliders" size={14} />
                  {selected ? `${selected.length} of ${impls.length}` : `All ${impls.length}`}
                </button>
                {pickerOpen && (
                  <Picker
                    impls={impls}
                    selected={selected}
                    onChange={setSelected}
                    onClose={() => setPickerOpen(false)}
                    maxCompare={maxCompare}
                  />
                )}
              </div>
              <div class="segmented" role="group" aria-label="View">
                <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
                  Chart
                </button>
                <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
                  Table
                </button>
              </div>
            </div>
          </div>

          {rankingNote && (
            <p class="ranking-note ex-ranking-note" role="note">
              <Icon name="info" size={14} />
              <span>{rankingNote}</span>
            </p>
          )}

          {visibleImpls.length === 0 ? (
            <p class="empty">No implementation selected. Use the selector above to choose some.</p>
          ) : measuredCount === 0 ? (
            !withheld.length && <p class="empty">Not measured in this run for the selected implementations.</p>
          ) : view === 'chart' ? (
            <BarChart data={data} metric={m} label={chartLabel} />
          ) : (
            <ResultTable data={data} metric={m} />
          )}
          {visibleImpls.length > 0 && <WithheldNotes lines={withheld} />}

          <div class="ex-foot">
            <p>
              {data.some((d) => d.value?.derived)
                ? 'Derived values are computed from scenario medians and carry no interval.'
                : anyInterval
                  ? 'Whiskers show the 95 % bootstrap confidence interval of the median.'
                  : `Median of ${plural(maxN || run.passes, 'pass', 'passes')}. ${(maxN || run.passes) < MIN_CI_PASSES ? `Fewer than ${MIN_CI_PASSES} passes, so no confidence interval is shown.` : ''}`}{' '}
              Ranks count all {impls.length} implementations.
            </p>
            <div class="ex-compare">
              {compareIds ? (
                <a class="btn btn-primary btn-sm" href={compareHref}>
                  <Icon name="compare" size={14} /> Compare {compareIds.length}
                </a>
              ) : (
                <a class="btn btn-secondary btn-sm" href={compareHref}>
                  <Icon name="compare" size={14} /> Compare implementations
                </a>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

const PROVENANCE_LABELS: Record<string, string> = { reference: 'Reference', community: 'Community', unknown: 'Other' };

/** Switches between published runs (each run has its own page); filterable by provenance. */
function RunSwitcher({ options, current }: { options: RunOption[]; current: string }) {
  const currentOpt = options.find((r) => r.id === current);
  const provenances = ['reference', 'community', 'unknown'].filter((p) => options.some((r) => (r.provenance || 'unknown') === p));
  const [filter, setFilter] = useState('all');
  const visible = options.filter((r) => filter === 'all' || (r.provenance || 'unknown') === filter || r.id === current);
  return (
    <div class="ex-runs">
      <label class="field ex-run-field">
        <span>Run</span>
        <span class="select">
          <select
            value={currentOpt?.href ?? ''}
            onChange={(e) => {
              // Only ever navigate to a run page this component rendered, not to whatever the DOM says.
              const value = (e.target as HTMLSelectElement).value;
              const target = options.find((r) => r.href === value);
              if (target) window.location.href = target.href;
            }}
          >
            {provenances.map((p) => {
              const opts = visible.filter((r) => (r.provenance || 'unknown') === p);
              if (!opts.length) return null;
              return (
                <optgroup key={p} label={`${PROVENANCE_LABELS[p]} runs`}>
                  {opts.map((r) => (
                    <option key={r.id} value={r.href}>
                      {r.label}
                      {r.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </span>
      </label>
      {provenances.length > 1 && (
        <div class="segmented" role="group" aria-label="Filter runs by provenance">
          {['all', ...provenances].map((p) => (
            <button key={p} type="button" aria-pressed={filter === p} onClick={() => setFilter(p)}>
              {p === 'all' ? 'All runs' : PROVENANCE_LABELS[p]}
            </button>
          ))}
        </div>
      )}
      <span class="ex-run-count muted">{options.length} runs published</span>
    </div>
  );
}

function ResultTable({ data, metric }: { data: BarDatum[]; metric: Metric }) {
  return (
    <div class="table-wrap ex-table" tabIndex={0} role="region" aria-label={`${metric.label} as a table`}>
      <table class="data">
        <thead>
          <tr>
            <th scope="col" class="r">
              Rank
            </th>
            <th scope="col">Implementation</th>
            <th scope="col" class="r">
              Median{metric.unit && metric.unit !== 'index' ? ` (${metric.unit})` : ''}
            </th>
            <th scope="col" class="r">
              95 % CI
            </th>
            <th scope="col" class="r">
              Min–max
            </th>
            <th scope="col" class="r">
              n
            </th>
            <th scope="col" class="r">
              CV
            </th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => {
            const v = d.value;
            return (
              <tr key={d.id}>
                <td class="r muted">{d.rank ?? '–'}</td>
                <th scope="row">
                  <LangChip language={d.language} /> <a href={d.href}>{d.label}</a>
                  {d.sublabel && <span class="muted"> · {d.sublabel}</span>}
                </th>
                <td class="r nowrap">
                  <strong title={v ? undefined : d.missing?.reason}>
                    {v ? formatNumber(v.m, metric.decimals ?? 0) : (d.missing?.label ?? 'not measured')}
                  </strong>
                </td>
                <td class="r nowrap muted">{v ? (formatInterval(v, metric, { unit: false }) ?? '—') : '—'}</td>
                <td class="r nowrap muted">{v ? (formatRange(v, metric) ?? '—') : '—'}</td>
                <td class="r muted">{v && !v.derived && isNum(v.n) ? v.n : '—'}</td>
                <td class="r muted">{v && isNum(v.cv) && (v.n ?? 0) >= 2 ? `${formatNumber(v.cv * 100, 1)} %` : '—'}</td>
                <td class="ex-flags">{d.flags ? d.flags.texts.join('; ') : <span class="muted">none</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Picker({
  impls,
  selected,
  onChange,
  onClose,
  maxCompare,
}: {
  impls: ImplLite[];
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
  onClose: () => void;
  maxCompare: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.ex-picker')) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const set = new Set(selected ?? impls.map((i) => i.id));
  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ids = impls.map((i) => i.id).filter((x) => next.has(x));
    onChange(ids.length === impls.length ? null : ids);
  };
  const langs = [...new Set(impls.map((i) => i.language))].sort((a, b) => a.localeCompare(b));
  const onlyLang = (lang: string) => onChange(impls.filter((i) => i.language === lang).map((i) => i.id));

  return (
    <div class="ex-picker-panel" id="ex-picker-panel" ref={ref} role="dialog" aria-label="Choose implementations">
      <div class="ex-picker-head">
        <strong>Implementations</strong>
        <div>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => onChange(null)}>
            All
          </button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => onChange([])}>
            None
          </button>
        </div>
      </div>
      <p class="ex-picker-hint">Select 2 to {maxCompare} to compare them side by side.</p>
      <div class="ex-picker-list">
        {langs.map((lang) => (
          <fieldset key={lang}>
            <legend>
              <LangChip language={lang} />
              {lang}
              <button type="button" class="ex-only" onClick={() => onlyLang(lang)}>
                only
              </button>
            </legend>
            {impls
              .filter((i) => i.language === lang)
              .map((i) => (
                <label key={i.id} class="ex-check">
                  <input type="checkbox" checked={set.has(i.id)} onChange={() => toggle(i.id)} />
                  <span>
                    {i.name}
                    {i.variant && <span class="muted"> · {i.variant}</span>}
                    <span class="ex-check-cat">{categoryLabel(i.category)}</span>
                  </span>
                </label>
              ))}
          </fieldset>
        ))}
      </div>
      <div class="ex-picker-foot">
        <button type="button" class="btn btn-secondary btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

