/**
 * Methodology versions. Runs carry their version in `run.methodology`; versions are numbered per domain, and what
 * each one measured comes from the domain (`domain.methodology.versions`). Version 0 is preliminary in every domain.
 */
import type { DomainSummary } from './types';

export interface MethodologyInfo {
  version: string;
  /** Short badge text */
  short: string;
  /** Longer label */
  label: string;
  preliminary: boolean;
  /** What the version measured, from the domain; null when the domain does not describe it. */
  summary: string | null;
}

export function methodologyInfo(version: string | null | undefined, domain?: Pick<DomainSummary, 'methodology'>): MethodologyInfo {
  const v = version ?? '';
  const summary = domain?.methodology?.versions?.[v] ?? null;
  if (!v)
    return {
      version: '',
      short: 'Unversioned',
      label: 'Unknown methodology',
      preliminary: true,
      summary: 'This run does not record its methodology version.',
    };
  if (v === '0') return { version: v, short: 'Preliminary', label: 'Preliminary methodology (v0)', preliminary: true, summary };
  return { version: v, short: `Methodology ${v}`, label: `Methodology ${v}`, preliminary: false, summary };
}

/** The versions a domain describes plus those its runs use, oldest first. */
export function domainMethodologies(domain: Pick<DomainSummary, 'methodology'>, runVersions: Array<string | null | undefined>): MethodologyInfo[] {
  const versions = new Set([...Object.keys(domain.methodology?.versions ?? {}), ...runVersions.map((v) => v ?? '')]);
  return [...versions].sort((a, b) => Number(a || -1) - Number(b || -1)).map((v) => methodologyInfo(v, domain));
}
