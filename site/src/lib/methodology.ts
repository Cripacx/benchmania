/**
 * Methodology versions the site knows how to describe. Runs carry their version in `run.methodology`;
 * unknown versions still render with a generic label. Keep in sync with docs/methodology.md.
 */

export interface MethodologyInfo {
  version: string;
  /** Short badge text */
  short: string;
  /** Longer label */
  label: string;
  preliminary: boolean;
  summary: string;
}

const KNOWN: Record<string, Omit<MethodologyInfo, 'version'>> = {
  '0': {
    short: 'Preliminary',
    label: 'Preliminary methodology (v0)',
    preliminary: true,
    summary:
      'Pre-release shell suite: throughput, p50/p99 latency, errors, start-up and memory only; floating image tags; peak memory recorded once per run; 3 s warm-up and 12 s measurement per scenario.',
  },
  '1': {
    short: 'Methodology 1',
    label: 'Methodology 1',
    preliminary: false,
    summary:
      'Engine release: pinned versions and image digests, CPU per request, database work verification, PSS per scenario, steal-time retries, energy, CPU clock, persisted-update and content-type checks, deterministic database content, 5 s warm-up and 15 s measurement.',
  },
};

export function methodologyInfo(version: string | null | undefined): MethodologyInfo {
  const v = version ?? '';
  const known = KNOWN[v];
  if (known) return { version: v, ...known };
  if (!v)
    return {
      version: '',
      short: 'Unversioned',
      label: 'Unknown methodology',
      preliminary: true,
      summary: 'This run does not record its methodology version.',
    };
  return {
    version: v,
    short: `Methodology ${v}`,
    label: `Methodology ${v}`,
    preliminary: false,
    summary: 'A methodology version this website does not describe yet. See the methodology document in the repository.',
  };
}

export function knownMethodologies(): MethodologyInfo[] {
  return Object.keys(KNOWN)
    .sort()
    .map((v) => methodologyInfo(v));
}
