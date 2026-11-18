/**
 * Types for the website dataset written by `publish` (schema benchcore.dataset/v1).
 *
 * Only the fields the site relies on are required; everything else is optional so a newer engine can
 * add fields without breaking the build. See README.md for the contract summary.
 */

export type Better = 'higher' | 'lower' | 'neutral';
export type Visibility = 'primary' | 'secondary' | 'diagnostic';

export interface Project {
  name: string;
  slug: string;
  tagline: string;
  description: string;
  repository: string;
  site_url?: string;
  license?: string;
  data_license?: string;
}

/** One entry of a domain's headline list: what the site shows first. */
export interface HeadlineEntry {
  metric: string;
  /** Without a scenario the metric is a derived metric from `run.derived`. */
  scenario?: string;
  label: string;
  hint?: string;
}

export interface DomainSummary {
  id: string;
  title: string;
  summary: string;
  status: string;
  service?: Record<string, unknown>;
  headline: HeadlineEntry[];
  description?: string;
  runs?: number;
  implementations?: number;
  scenarios?: number;
  machines?: number;
  default_run?: string | null;
}

export interface DatasetIndex {
  schema: string;
  generated: string;
  project: Project;
  domains: DomainSummary[];
}

export interface Metric {
  id: string;
  label: string;
  unit: string;
  better: Better;
  group: string;
  description?: string;
  decimals?: number;
  visibility?: Visibility;
}

export interface DerivedDefinition {
  id: string;
  kind: string;
  metric: string;
  scenarios: string[] | '*';
  /** An implementation gets the derived value only if this metric stays at or below `max` in every scenario. */
  valid_when?: { metric: string; max: number };
}

export interface Scenario {
  id: string;
  title: string;
  kind: string;
  order: number;
  description?: string;
  params?: Record<string, unknown>;
}

export interface Implementation {
  id: string;
  name: string;
  language: string;
  category: string;
  runtime?: string;
  framework?: string;
  variant?: string;
  description?: string;
  notes?: string[];
  maintainers?: string[];
  versions?: Record<string, string>;
  /** Path relative to the implementation directory, e.g. "../../sources/aspnet". */
  source?: string;
  [key: string]: unknown;
}

export interface Machine {
  id: string;
  label?: string;
  cpu?: {
    model?: string;
    vendor?: string;
    logical?: number;
    physical_cores?: number;
    sockets?: number;
    smt?: boolean;
    governor?: string | null;
    driver?: string | null;
    max_mhz?: number | null;
    turbo?: boolean | null;
  };
  memory_gib?: number;
  kernel?: string;
  arch?: string;
  os?: { name?: string; source?: string };
  virtualization?: string;
  rapl?: unknown;
  /** Set for machines the maintainers operate and measure on (results/reference-runs.toml). */
  reference?: { label?: string; operator?: string } | null;
  docker?: {
    version?: string | null;
    cgroup_driver?: string | null;
    cgroup_version?: string | null;
    storage_driver?: string | null;
    rootless?: boolean | null;
  };
  [key: string]: unknown;
}

/** Summary of one metric over the passes of a run. */
export interface Stat {
  /** median */
  m: number;
  /** 95 % bootstrap confidence interval of the median; null below five passes (older datasets: min..max) */
  lo: number | null;
  hi: number | null;
  min: number;
  max: number;
  /** number of passes the metric was available in */
  n: number;
  /** coefficient of variation between passes */
  cv: number;
}

export interface Flag {
  level: 'info' | 'warning' | 'error' | string;
  /** "run", "<implementation>" (the whole measurement of it) or "<implementation>/<scenario>" */
  scope: string;
  message: string;
  pass?: number;
  /** Set when the flag is about this one metric only; without it the flag covers everything measured in its scope. */
  metric?: string;
}

export interface RunImplementation {
  image?: { size_bytes?: number | null; [key: string]: unknown };
  check?: string | string[] | null;
  manifest?: Partial<Implementation> & { versions_note?: string };
}

export interface CpuLayout {
  service?: number[];
  environment?: number[];
  loadgen?: number[];
  idle?: number[];
  smt?: boolean;
  warnings?: string[];
}

/** "reference": measured by the maintainers, run id listed in results/reference-runs.toml; "community": every other run. */
export type Provenance = 'reference' | 'community';

export interface Run {
  id: string;
  created: string;
  finished?: string | null;
  status?: string | null;
  methodology?: string | null;
  provenance?: Provenance | string | null;
  machine: string;
  options?: { passes?: number; quick?: boolean; note?: string; [key: string]: unknown };
  layout?: CpuLayout;
  tool?: { name?: string; engine_version?: string; git?: unknown };
  passes: number;
  implementations: Record<string, RunImplementation>;
  results: Record<string, Record<string, Record<string, Stat>>>;
  derived: Record<string, Record<string, number>>;
  /** implementation → derived metric → why the publisher withheld the value */
  withheld?: Record<string, Record<string, string>>;
  flags: Flag[];
}

export interface DomainData {
  schema: string;
  domain: DomainSummary;
  metrics: Record<string, Metric>;
  derived: DerivedDefinition[];
  scenarios: Scenario[];
  implementations: Implementation[];
  machines: Record<string, Machine>;
  runs: Run[];
  default_run: string | null;
}

/** A value shown for one implementation: either a summarized metric or a derived number. */
export interface Value {
  m: number;
  lo?: number | null;
  hi?: number | null;
  min?: number;
  max?: number;
  n?: number;
  cv?: number;
  /** true for derived metrics (computed from medians, no interval) */
  derived?: boolean;
}
