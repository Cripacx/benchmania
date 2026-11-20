/**
 * What lets several domains share the site: comparisons and methodology text declared by a domain, domain-specific
 * manifest tables, status and machine caveats. Synthetic fixtures only: the published numbers are not tested here.
 */
import { describe, expect, it } from 'vitest';
import { domainMethodologies, methodologyInfo } from '../src/lib/methodology';
import {
  declaredComparison,
  declaredSuggestions,
  domainStatus,
  groupMetricIds,
  implLabel,
  isVirtualMachine,
  manifestDetails,
  scenarioParams,
  suggestedComparisons,
} from '../src/lib/model';
import type { DomainData, Run } from '../src/lib/types';

const domain = {
  domain: {
    id: 'tools',
    title: 'Tools',
    summary: '',
    status: 'experimental',
    headline: [],
    compare: [
      { title: 'Same revision', ids: ['go', 'rust'], note: 'Like for like.' },
      { title: 'Three tools', ids: ['old', 'go', 'rust'], note: 'All three.' },
      { title: 'All lines', ids: ['old', 'go', 'gone'] },
    ],
    methodology: { versions: { '1': 'First version.' } },
  },
  metrics: {},
  derived: [],
  scenarios: [
    { id: 'check', title: 'Check', kind: 'compile', order: 1, params: { mode: 'check', cpus: 4 } },
    { id: 'check-1', title: 'Check on one core', kind: 'compile', order: 2, params: { mode: 'single', cpus: 1 } },
    { id: 'emit', title: 'Emit', kind: 'compile', order: 3, params: { mode: 'emit', cpus: 4 } },
  ],
  implementations: [
    { id: 'old', name: 'tool 1', language: 'JavaScript', category: 'tool', variant: 'stable', runtime: 'Node.js' },
    {
      id: 'go',
      name: 'tool 2 (beta)',
      language: 'Go',
      category: 'tool',
      variant: 'pre-release',
      compiler: {
        package: 'tool',
        repository: 'https://example.org/tool',
        command: ['tool', '-p', '{tsconfig}'],
        env: {},
        modes: { check: ['--noEmit'], single: ['--noEmit', '--single'], emit: ['--outDir', '{out}'] },
      },
    },
    { id: 'rust', name: 'port', language: 'Rust', category: 'tool', variant: 'experimental port', runtime: 'Node.js' },
  ],
  machines: {},
  runs: [],
  default_run: null,
} as unknown as DomainData;

describe('declared comparisons', () => {
  it('replace the guesses, keep their notes and are limited to implementations of the run', () => {
    // old and rust share a runtime, which would be a guessed suggestion without declared ones.
    expect(suggestedComparisons(domain, ['old', 'go', 'rust'])).toEqual([
      { title: 'Same revision', ids: ['go', 'rust'], note: 'Like for like.' },
      { title: 'Three tools', ids: ['old', 'go', 'rust'], note: 'All three.' },
    ]);
    const undeclared = { ...domain, domain: { ...domain.domain, compare: [] } };
    expect(suggestedComparisons(undeclared, ['old', 'go', 'rust'])).toEqual([{ title: 'Node.js: tool 1 vs port', ids: ['old', 'rust'], note: null }]);
  });

  it('are offered only when every declared member is in the run, never shrunk under a title and note written for more', () => {
    // A partial run without rust: "Three tools" would otherwise become a two-tool comparison whose note speaks of three.
    expect(declaredSuggestions(domain, ['go', 'old'])).toEqual([]);
    expect(suggestedComparisons(domain, ['go', 'old'])).toEqual([]);
    expect(declaredSuggestions(domain, ['go', 'rust']).map((s) => s.title)).toEqual(['Same revision']);
    expect(declaredSuggestions(domain, ['rust'])).toEqual([]);
    // "All lines" names an implementation that is in no run: it is never offered.
    expect(declaredSuggestions(domain, ['old', 'go', 'rust']).map((s) => s.title)).not.toContain('All lines');
    // A declared comparison larger than the allowed size is not cut down either.
    expect(declaredSuggestions(domain, ['old', 'go', 'rust'], 2).map((s) => s.title)).toEqual(['Same revision']);
  });

  it('are found for a selection in any order', () => {
    expect(declaredComparison(domain, ['rust', 'go'])?.note).toBe('Like for like.');
    expect(declaredComparison(domain, ['rust', 'old', 'go'])?.note).toBe('All three.');
    expect(declaredComparison(domain, ['rust', 'old'])).toBeNull();
  });
});

describe('manifest details', () => {
  it('turn a command with modes into one full command per mode, named by the scenarios that run it', () => {
    const [compiler, ...rest] = manifestDetails(domain, 'go');
    expect(rest).toEqual([]);
    expect(compiler?.title).toBe('Compiler');
    expect(compiler?.rows).toEqual([
      { label: 'package', kind: 'text', value: 'tool' },
      { label: 'repository', kind: 'link', value: 'https://example.org/tool' },
      { label: 'check', kind: 'code', value: 'tool -p {tsconfig} --noEmit', scenarios: ['Check'] },
      { label: 'single', kind: 'code', value: 'tool -p {tsconfig} --noEmit --single', scenarios: ['Check on one core'] },
      { label: 'emit', kind: 'code', value: 'tool -p {tsconfig} --outDir {out}', scenarios: ['Emit'] },
    ]);
  });

  it('prefer the manifest the run recorded and add nothing for the fields every page shows', () => {
    const run = { implementations: { go: { manifest: { id: 'go', name: 'x', notes: ['n'], compiler: { package: 'measured' } } } } } as unknown as Run;
    expect(manifestDetails(domain, 'go', run)).toEqual([
      { key: 'compiler', title: 'Compiler', rows: [{ label: 'package', kind: 'text', value: 'measured' }] },
    ]);
    expect(manifestDetails(domain, 'old')).toEqual([]);
  });
});

describe('labels and status', () => {
  it('joins a name and its variant one way, also when the name has parentheses', () => {
    expect(implLabel({ name: 'tool 2 (beta)', variant: 'pre-release' })).toBe('tool 2 (beta) · pre-release');
    expect(implLabel({ name: 'tool 1', variant: null })).toBe('tool 1');
  });

  it('marks experimental domains and nothing else', () => {
    expect(domainStatus('experimental')?.label).toBe('Experimental');
    expect(domainStatus('stable')).toBeNull();
    expect(domainStatus(undefined)).toBeNull();
  });

  it('calls a machine virtual only when the fingerprint names a hypervisor', () => {
    expect(isVirtualMachine({ virtualization: 'kvm' })).toBe(true);
    expect(isVirtualMachine({ virtualization: 'none' })).toBe(false);
    expect(isVirtualMachine({})).toBe(false);
    expect(isVirtualMachine(undefined)).toBe(false);
  });

  it('describes core counts of a scenario', () => {
    expect(scenarioParams(domain.scenarios[0]!)).toEqual(['4 cores']);
    expect(scenarioParams(domain.scenarios[1]!)).toEqual(['one core']);
  });

  it('orders a time group right after the summary', () => {
    const metrics = {
      a: { id: 'a', label: 'a', unit: '', better: 'lower', group: 'memory' },
      b: { id: 'b', label: 'b', unit: '', better: 'lower', group: 'time' },
      c: { id: 'c', label: 'c', unit: '', better: 'higher', group: 'summary' },
    } as const;
    expect(groupMetricIds(metrics as never, ['a', 'b', 'c']).map((g) => g.group)).toEqual(['summary', 'time', 'memory']);
  });
});

describe('methodology versions', () => {
  it('take what a version measured from its domain', () => {
    expect(methodologyInfo('1', domain.domain).summary).toBe('First version.');
    expect(methodologyInfo('1').summary).toBeNull();
    expect(methodologyInfo('0', domain.domain)).toMatchObject({ preliminary: true, summary: null });
  });

  it('list the described versions and those runs use, oldest first', () => {
    expect(domainMethodologies(domain.domain, ['2', '1', null]).map((v) => v.version)).toEqual(['', '1', '2']);
  });
});
