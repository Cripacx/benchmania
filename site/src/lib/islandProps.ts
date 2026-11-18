/**
 * Builds the props of the client islands from the dataset (server side, at build time).
 */
import { formatDate, plural } from './format';
import { methodologyInfo } from './methodology';
import {
  byVisibility,
  categories,
  categoryLabel,
  derivedExplanation,
  derivedScale,
  flagImplementation,
  flagsForImplementation,
  headlineValue,
  languages,
  machineName,
  measuredMetricIds,
  measuredScenarios,
  metricOrFallback,
  missingValue,
  runImplementationIds,
  implementation,
  suggestedComparisons,
  valueFlagTexts,
} from './model';
import { joinBase, routes } from './paths';
import type { DomainData, Flag, HeadlineEntry, Run } from './types';
import { implLite, metricRegistry, runImpls, runSlice, scenarioLite, type RunOption } from './view';

export const MAX_COMPARE = 4;

/** Flags that belong to an implementation (run-level flags are shown in the run notice instead). */
export function implementationFlags(run: Run): Flag[] {
  return (run.flags ?? []).filter((f) => flagImplementation(f) !== null);
}

/** What islands need to attach flags and "no index" reasons to values (see valueFlags, missingValue). */
function valueContext(domain: DomainData, run: Run) {
  return {
    derived: domain.derived ?? [],
    flags: implementationFlags(run),
  };
}

export function runOptions(domain: DomainData, base: string): RunOption[] {
  const defaultId = domain.default_run;
  return domain.runs.map((r) => ({
    id: r.id,
    label: `${formatDate(r.created)} · ${methodologyInfo(r.methodology).short} · ${plural(r.passes, 'pass', 'passes')} · ${machineName(domain.machines[r.machine], r.machine)}`,
    href: joinBase(base, r.id === defaultId ? routes.domain(domain.domain.id) : routes.run(domain.domain.id, r.id)),
    provenance: r.provenance ?? 'unknown',
    methodology: r.methodology ?? '',
    isDefault: r.id === defaultId,
  }));
}

export function derivedNotes(domain: DomainData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of domain.derived ?? []) {
    const text = derivedExplanation(domain, d.id);
    if (text) out[d.id] = text;
  }
  return out;
}

export function leaderboardProps(domain: DomainData, run: Run, base: string) {
  const headline = domain.domain.headline ?? [];
  const impls = runImplementationIds(domain, run).map((id) => implementation(domain, id, run));
  const columns = headline.map((h) => {
    const scenario = h.scenario ? domain.scenarios.find((s) => s.id === h.scenario) : undefined;
    return {
      key: `${h.scenario ?? 'derived'}:${h.metric}`,
      label: h.label,
      hint: h.hint ?? '',
      metric: metricOrFallback(domain.metrics, h.metric),
      scenarioTitle: scenario ? scenario.title : null,
      scale: h.scenario ? null : derivedScale(domain, h.metric),
      href: joinBase(base, `${routes.domain(domain.domain.id)}?scenario=${h.scenario ?? 'overall'}&metric=${h.metric}`),
    };
  });
  const rows = impls.map((impl) => ({
    impl: implLite(impl),
    href: joinBase(base, routes.implementation(domain.domain.id, impl.id)),
    values: headline.map((h) => headlineValue(run, h, impl.id)),
    flags: headline.map((h) => valueFlagTexts(domain, run.flags, impl.id, h.scenario ?? null, h.metric)),
    missing: headline.map((h) => missingValue(run, impl.id, h.scenario ?? null, h.metric)),
    flagged: flagsForImplementation(run, impl.id).length > 0,
  }));
  return {
    columns,
    rows,
    languages: languages(impls),
    categories: categories(impls).map((c) => ({ id: c, label: categoryLabel(c) })),
    caption: `${domain.domain.title}: implementations ranked by ${columns[0]?.label ?? 'the first headline metric'}`,
  };
}

/** Default scenario and metric for the explorer: the first headline entry that has data. */
export function explorerDefaults(domain: DomainData, run: Run): { scenario: string; metric: string } {
  const headline: HeadlineEntry[] = domain.domain.headline ?? [];
  for (const h of headline) {
    const ids = measuredMetricIds(domain.metrics, run, h.scenario ?? null);
    if (ids.includes(h.metric)) return { scenario: h.scenario ?? 'overall', metric: h.metric };
  }
  const first = measuredScenarios(domain, run)[0];
  if (first) {
    const ids = measuredMetricIds(domain.metrics, run, first.id);
    const vis = byVisibility(domain.metrics, ids);
    return { scenario: first.id, metric: vis.primary[0] ?? ids[0] ?? '' };
  }
  return { scenario: 'overall', metric: '' };
}

/** `scope`: the run id on /<domain>/runs/<run>/ routes, null on the short routes (links follow the route). */
export function explorerProps(domain: DomainData, run: Run, base: string, scope: string | null) {
  const initial = explorerDefaults(domain, run);
  return {
    base,
    domainId: domain.domain.id,
    metrics: metricRegistry(domain),
    scenarios: measuredScenarios(domain, run).map(scenarioLite),
    impls: runImpls(domain, run),
    run: runSlice(run),
    headline: domain.domain.headline ?? [],
    derivedNotes: derivedNotes(domain),
    ...valueContext(domain, run),
    scope,
    runOptions: runOptions(domain, base),
    initialScenario: initial.scenario,
    initialMetric: initial.metric,
    maxCompare: MAX_COMPARE,
  };
}

export function compareProps(domain: DomainData, run: Run, base: string, scope: string | null) {
  const ids = runImplementationIds(domain, run);
  return {
    base,
    domainId: domain.domain.id,
    metrics: metricRegistry(domain),
    scenarios: measuredScenarios(domain, run).map(scenarioLite),
    impls: runImpls(domain, run),
    run: runSlice(run),
    headline: domain.domain.headline ?? [],
    ...valueContext(domain, run),
    scope,
    // Implementations of the domain that this run does not contain, so ?ids= can name them.
    notInRun: Object.fromEntries(
      domain.implementations.filter((i) => !ids.includes(i.id)).map((i) => [i.id, i.variant ? `${i.name} (${i.variant})` : i.name]),
    ),
    suggestions: suggestedComparisons(domain, ids, MAX_COMPARE),
    maxCompare: MAX_COMPARE,
  };
}
