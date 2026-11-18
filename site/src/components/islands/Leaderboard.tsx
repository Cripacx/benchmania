/**
 * Headline leaderboard: implementations ranked by the domain's headline metrics, side by side with
 * inline bars. Sortable by every column, filterable by language and category. On narrow screens only
 * the active column is shown, and a select switches it.
 */
import { useMemo, useState } from 'preact/hooks';
import { formatInterval, formatNumber, formatValue, isNum, plural } from '../../lib/format';
import { categoryLabel, compareBest, rankMap, type FlagNote } from '../../lib/model';
import type { Better, Metric, Value } from '../../lib/types';
import type { ImplLite } from '../../lib/view';
import { Icon } from './Icon';

export interface LeaderboardColumn {
  key: string;
  label: string;
  hint: string;
  metric: Metric;
  /** The scenario title for scenario metrics, null for derived ones. */
  scenarioTitle: string | null;
  /** Scale of a relative index, e.g. "100 = best in all 6 scenarios"; null otherwise. */
  scale: string | null;
  href: string;
}

export interface LeaderboardRow {
  impl: ImplLite;
  href: string;
  values: Array<Value | null>;
  /** Quality flags behind each value (valueFlagNote), per column; null when none. */
  flags: Array<FlagNote | null>;
  /** How each missing value reads ("not measured", "no index") and why, per column. */
  missing: Array<{ label: string; reason: string }>;
  flagged: boolean;
}

interface Props {
  columns: LeaderboardColumn[];
  rows: LeaderboardRow[];
  languages: string[];
  categories: Array<{ id: string; label: string }>;
  caption: string;
}

type Dir = 'best' | 'worst';

function directionIcon(better: Better) {
  if (better === 'higher') return <Icon name="arrowUp" size={12} strokeWidth={2} />;
  if (better === 'lower') return <Icon name="arrowDown" size={12} strokeWidth={2} />;
  return null;
}

export function Leaderboard({ columns, rows, languages, categories, caption }: Props) {
  const [sortCol, setSortCol] = useState(0);
  const [dir, setDir] = useState<Dir>('best');
  const [language, setLanguage] = useState('');
  const [category, setCategory] = useState('');

  const ranks = useMemo(
    () => columns.map((c, i) => rankMap(rows.map((r) => ({ id: r.impl.id, value: r.values[i]?.m ?? null })), c.metric.better)),
    [columns, rows],
  );
  const maxima = useMemo(
    () => columns.map((_, i) => rows.reduce((acc, r) => Math.max(acc, r.values[i]?.m ?? 0), 0)),
    [columns, rows],
  );

  const col = columns[sortCol] ?? columns[0];
  const better: Better = col?.metric.better ?? 'higher';
  const sorted = useMemo(() => {
    const list = rows.filter((r) => (!language || r.impl.language === language) && (!category || r.impl.category === category));
    return list
      .map((r, index) => ({ r, index }))
      .sort((a, b) => {
        const av = a.r.values[sortCol]?.m ?? null;
        const bv = b.r.values[sortCol]?.m ?? null;
        if (!isNum(av) || !isNum(bv)) return compareBest(av, bv, better) || a.index - b.index;
        const c = compareBest(av, bv, better);
        return (dir === 'best' ? c : -c) || a.index - b.index;
      })
      .map((e) => e.r);
  }, [rows, sortCol, dir, language, category, better]);

  const onSort = (i: number) => {
    if (i === sortCol) setDir(dir === 'best' ? 'worst' : 'best');
    else {
      setSortCol(i);
      setDir('best');
    }
  };

  const ariaSort = (i: number): 'ascending' | 'descending' | 'none' => {
    if (i !== sortCol) return 'none';
    const b = columns[i]?.metric.better;
    const ascending = (b === 'lower') === (dir === 'best');
    return ascending ? 'ascending' : 'descending';
  };

  const filtered = !!language || !!category;

  return (
    <div class="lb" data-active={sortCol}>
      <div class="lb-toolbar">
        <div class="lb-filters">
          <label class="field">
            <span>Language</span>
            <span class="select">
              <select value={language} onChange={(e) => setLanguage((e.target as HTMLSelectElement).value)}>
                <option value="">All languages</option>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label class="field">
            <span>Category</span>
            <span class="select">
              <select value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label class="field lb-mobile-sort">
            <span>Ranked by</span>
            <span class="select">
              <select
                value={String(sortCol)}
                onChange={(e) => {
                  setSortCol(Number((e.target as HTMLSelectElement).value));
                  setDir('best');
                }}
              >
                {columns.map((c, i) => (
                  <option key={c.key} value={String(i)}>
                    {c.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
        <p class="lb-count" aria-live="polite">
          {filtered ? `${sorted.length} of ${plural(rows.length, 'implementation')}` : plural(rows.length, 'implementation')}
          {filtered && (
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => {
                setLanguage('');
                setCategory('');
              }}
            >
              Clear filters
            </button>
          )}
        </p>
      </div>

      <div class="lb-table-wrap">
        <table class="lb-table">
          <caption class="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" class="c-rank">
                <span class="visually-hidden">Rank by {col?.label}</span>
                <span aria-hidden="true">#</span>
              </th>
              <th scope="col" class="c-impl">
                Implementation
              </th>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  class={`c-metric${i === sortCol ? ' is-active' : ''}`}
                  aria-sort={ariaSort(i)}
                >
                  <button type="button" class="lb-sort" onClick={() => onSort(i)} title={c.hint}>
                    <span class="lb-sort-label">
                      {c.label}
                      <span class={`lb-sort-ind${i === sortCol ? ' on' : ''}`} aria-hidden="true">
                        <Icon name={i === sortCol && dir === 'worst' ? 'arrowUp' : 'arrowDown'} size={12} strokeWidth={2} />
                      </span>
                    </span>
                    <span class="lb-sort-sub">
                      {directionIcon(c.metric.better)}
                      {c.metric.unit === 'index' ? 'index' : c.metric.unit}
                      {c.scenarioTitle ? ` · ${c.scenarioTitle}` : ''}
                    </span>
                    {c.scale && <span class="lb-sort-sub lb-scale">{c.scale}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const rank = ranks[sortCol]?.get(r.impl.id) ?? null;
              return (
                <tr key={r.impl.id}>
                  <td class={`c-rank${rank && rank <= 3 ? ' top' : ''}`}>{rank ?? '–'}</td>
                  <th scope="row" class="c-impl">
                    <a href={r.href} class="lb-name">
                      {r.impl.name}
                    </a>
                    {r.impl.variant && <span class="tag lb-variant">{r.impl.variant}</span>}
                    <span class="lb-sub">
                      {r.impl.runtime && r.impl.runtime !== r.impl.language ? r.impl.runtime : r.impl.language}
                      <span class="lb-cat">{categoryLabel(r.impl.category)}</span>
                      {r.flagged && (
                        <span class="lb-flag" title="Quality flags were raised for this implementation">
                          <Icon name="alert" size={12} /> flagged
                        </span>
                      )}
                    </span>
                  </th>
                  {columns.map((c, i) => {
                    const v = r.values[i] ?? null;
                    const max = maxima[i] ?? 0;
                    const width = v && max > 0 ? Math.max(1.5, (v.m / max) * 100) : 0;
                    const ci = formatInterval(v, c.metric);
                    const label = v ? formatValue(v.m, c.metric) : 'not measured in this run';
                    const note = r.flags[i] ?? null;
                    const missing = r.missing[i] ?? { label: 'not measured', reason: 'Not measured in this run.' };
                    const flagNote = note ? `
Flags: ${note.texts.join('; ')}` : '';
                    return (
                      <td
                        key={c.key}
                        class={`c-metric${i === sortCol ? ' is-active' : ''}`}
                        title={v ? `${c.label}: ${label}${ci ? ` (95 % CI ${ci})` : ''}${flagNote}` : `${c.label}: ${missing.reason}`}
                      >
                        {v ? (
                          <>
                            <span class="lb-val">
                              {note && (
                                <span class={`lb-cell-flag is-${note.marker}`} aria-label={`Flagged: ${note.texts.join('; ')}`}>
                                  <Icon name={note.marker} size={12} />
                                </span>
                              )}
                              {formatNumber(v.m, c.metric.decimals ?? 0)}
                              {c.metric.unit !== 'index' && <span class="lb-unit">{c.metric.unit}</span>}
                            </span>
                            <span class="lb-bar" aria-hidden="true">
                              <span class="lb-bar-fill" style={{ width: `${width}%` }} />
                            </span>
                          </>
                        ) : (
                          <span class="lb-na">
                            {missing.label}
                            <span class="visually-hidden">. {missing.reason}</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} class="empty">
                  No implementation matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
