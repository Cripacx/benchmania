// @ts-check
import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

/**
 * Deployment settings come from the environment so the same source builds for a custom domain
 * (BASE_PATH=/) and for GitHub Pages project sites (BASE_PATH=/<repository>/).
 *
 *   BASE_PATH  sub-path the site is served from (default "/")
 *   SITE_URL   public origin, used for canonical URLs and the sitemap
 *              (default: the origin of project.site_url in src/data/index.json)
 */
/** @param {string | undefined} raw */
function normalizeBase(raw) {
  let base = (raw ?? '').trim();
  if (!base || base === '/') return '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

/** @param {string | undefined} raw */
function siteOrigin(raw) {
  const candidates = [raw];
  try {
    const index = JSON.parse(readFileSync(new URL('./src/data/index.json', import.meta.url), 'utf8'));
    candidates.push(index?.project?.site_url);
  } catch {
    // The dataset is validated elsewhere; a missing file only means no default origin.
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // ignore malformed values and try the next candidate
    }
  }
  return undefined;
}

export default defineConfig({
  output: 'static',
  compressHTML: false,
  site: siteOrigin(process.env.SITE_URL),
  base: normalizeBase(process.env.BASE_PATH),
  trailingSlash: 'always',
  build: { format: 'directory' },
  integrations: [preact()],
  devToolbar: { enabled: false },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
});
