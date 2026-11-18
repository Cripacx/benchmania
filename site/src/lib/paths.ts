/**
 * Internal URLs. Every link and asset goes through `joinBase` so the site works under a sub-path
 * (GitHub Pages project sites) as well as at the root of a domain.
 *
 * Route helpers return paths without the base; components pass them to `href()` (server) or
 * `joinBase(base, …)` (islands, which receive the base as a prop).
 */

export function normalizeBase(base: string | undefined): string {
  let b = (base ?? '/').trim();
  if (!b || b === '/') return '/';
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

/** Joins the base path and a site-relative path ("/backend/" or "backend/"). */
export function joinBase(base: string | undefined, path = ''): string {
  const b = normalizeBase(base);
  const p = path.replace(/^\/+/, '');
  return `${b}${p}`;
}

/** Base path of the current build (with trailing slash). */
export function basePath(): string {
  return normalizeBase(import.meta.env.BASE_URL);
}

export function href(path = ''): string {
  return joinBase(basePath(), path);
}

const enc = encodeURIComponent;

/**
 * Result pages exist twice: the short canonical routes show the default run (`scope` null), and run-scoped
 * routes under /<domain>/runs/<run>/ show one specific run. Pages of a run-scoped view pass the run id as
 * `scope` so every link they emit stays inside that run.
 */
const runRoot = (domain: string, run: string) => `/${enc(domain)}/runs/${enc(run)}/`;
const scopeRoot = (domain: string, scope?: string | null) => (scope ? runRoot(domain, scope) : `/${enc(domain)}/`);

export const routes = {
  home: () => '/',
  domain: (domain: string) => `/${enc(domain)}/`,
  /** The explorer: /<domain>/ for the default run, the run page for a run scope. */
  explorer: (domain: string, scope?: string | null) => scopeRoot(domain, scope),
  implementation: (domain: string, impl: string, scope?: string | null) => `${scopeRoot(domain, scope)}${enc(impl)}/`,
  compare: (domain: string, ids: string[] = [], scope?: string | null) =>
    `${scopeRoot(domain, scope)}compare/${ids.length ? `?ids=${ids.map(enc).join(',')}` : ''}`,
  runs: (domain: string) => `/${enc(domain)}/runs/`,
  run: runRoot,
  methodology: () => '/methodology/',
  machines: () => '/machines/',
  machine: (id: string) => `/machines/#machine-${enc(id)}`,
  /** The contribute page, optionally at one of its sections (`submit`, `implementation`, `domain`, …). */
  contribute: (section?: string) => (section ? `/contribute/#${enc(section)}` : '/contribute/'),
  data: () => '/data/',
  dataFile: (file: string) => `/data/${enc(file)}`,
};

/** Route segments that can never be implementation ids, because pages live there. */
export const RESERVED_SEGMENTS = new Set(['compare', 'runs']);

/** Site-relative path → absolute URL on the public origin (for canonical links and the sitemap). */
export function absoluteUrl(site: URL | string | undefined, pathWithBase: string): string | undefined {
  if (!site) return undefined;
  try {
    return new URL(pathWithBase, site).toString();
  } catch {
    return undefined;
  }
}
