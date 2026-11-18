/**
 * Post-build verification of dist/ (run after `npm run build`, with the same BASE_PATH):
 *
 *  1. Every page the dataset implies exists: domain explorer, compare, runs, every implementation and run page.
 *  2. Every implementation of the default run appears on the home page (featured domain) and on its explorer page.
 *  3. Every internal link and asset (href/src attributes, island props, CSS url()) resolves to a file in dist/
 *     and stays under the configured base path; page links end with a slash.
 *  4. No page shows "NaN", "undefined" or "Infinity" (text and attribute values; script and style bodies excluded).
 *  5. Every HTML page has a <title> and exactly one <h1>.
 *  6. Run-scoped pages (/<domain>/runs/<run>/, .../compare/, .../<impl>/) exist for every run, and on all of them,
 *     including those of the current default run, no link in <main> leaves the run for a short results route
 *     (/<domain>/, /<domain>/compare/, /<domain>/<impl>/) unless it is marked `data-run-exit`, and every island on
 *     them is scoped to the run. Only pages of a non-default run say "Not the default run.". Links to methodology,
 *     machines, data, runs and home are fine.
 *
 * Usage: BASE_PATH=/repo/ node scripts/verify.ts   (BASE_PATH defaults to the base found in dist/index.html)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const dataDir = join(root, 'src', 'data');

const problems: string[] = [];
const fail = (msg: string) => problems.push(msg);
let checkedLinks = 0;

function normalizeBase(b: string | undefined): string {
  let s = (b ?? '/').trim();
  if (!s || s === '/') return '/';
  if (!s.startsWith('/')) s = `/${s}`;
  if (!s.endsWith('/')) s = `${s}/`;
  return s;
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

function inferBase(): string {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const m = html.match(/<link rel="icon" href="([^"]*?)favicon\.svg"/);
  return normalizeBase(m?.[1]);
}

const base = process.env.BASE_PATH !== undefined ? normalizeBase(process.env.BASE_PATH) : inferBase();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(dist);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const cssFiles = files.filter((f) => f.endsWith('.css'));

/** dist path → URL path under the base, e.g. dist/backend/index.html → /repo/backend/ */
function urlOf(file: string): string {
  const rel = relative(dist, file).split(sep).join('/');
  const path = rel.endsWith('index.html') ? rel.slice(0, -'index.html'.length) : rel;
  return `${base}${path}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Resolves an internal URL (absolute path, already under the base) to a file in dist, or null. */
function resolveTarget(urlPath: string): string | null {
  const rest = decodeURIComponent(urlPath.slice(base.length));
  const candidate = join(dist, ...rest.split('/'));
  if (rest === '' || rest.endsWith('/')) {
    const index = join(candidate, 'index.html');
    return existsSync(index) ? index : null;
  }
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

function checkLink(raw: string, from: string, context: string) {
  const value = raw.trim();
  if (!value || value.startsWith('#')) return;
  if (/^(https?:|mailto:|data:|javascript:|blob:|tel:)/i.test(value)) return;
  if (value.startsWith('//')) return;
  checkedLinks++;
  const fromUrl = urlOf(from);
  const absolute = value.startsWith('/') ? value : posix.join(posix.dirname(fromUrl.endsWith('/') ? `${fromUrl}x` : fromUrl), value);
  const path = absolute.split(/[?#]/)[0] ?? absolute;
  if (base !== '/' && !(path === base || path.startsWith(base))) {
    fail(`${rel(from)}: ${context} "${value}" is outside the base path ${base}`);
    return;
  }
  const target = resolveTarget(path);
  if (!target) {
    const asDir = resolveTarget(`${path}/`);
    if (asDir) fail(`${rel(from)}: ${context} "${value}" should end with a slash`);
    else fail(`${rel(from)}: ${context} "${value}" does not resolve to a file in dist/`);
  }
}

/** Every string inside a value; strings holding JSON objects or arrays are parsed and searched too. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        collectStrings(JSON.parse(t), out);
        return out;
      } catch {
        // not JSON: treat as a plain string
      }
    }
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

function rel(file: string): string {
  return relative(root, file).split(sep).join('/');
}

// ---------------------------------------------------------------------------------------------
// Dataset expectations
// ---------------------------------------------------------------------------------------------

interface DomainJson {
  domain: { id: string; title: string };
  implementations: Array<{ id: string; name: string }>;
  runs: Array<{ id: string; results?: Record<string, unknown>; implementations?: Record<string, unknown> }>;
  default_run: string | null;
}

const index = JSON.parse(readFileSync(join(dataDir, 'index.json'), 'utf8')) as {
  project: { name: string };
  domains: Array<{ id: string; status: string }>;
};
const domains: DomainJson[] = index.domains
  .filter((d) => d.status !== 'example' && existsSync(join(dataDir, `${d.id}.json`)))
  .map((d) => JSON.parse(readFileSync(join(dataDir, `${d.id}.json`), 'utf8')) as DomainJson);

const pageFile = (urlPath: string) => join(dist, ...urlPath.split('/').filter(Boolean), 'index.html');
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const htmlText = (html: string) => decodeEntities(html);

let expectedPages = 0;
const home = read(join(dist, 'index.html')) ?? '';

domains.forEach((d, i) => {
  const id = d.domain.id;
  const pages = [`${id}/`, `${id}/compare/`, `${id}/runs/`];
  const implIds = new Set([...d.implementations.map((x) => x.id), ...d.runs.flatMap((r) => Object.keys(r.results ?? {}))]);
  for (const impl of implIds) pages.push(`${id}/${impl}/`);
  for (const run of d.runs) {
    pages.push(`${id}/runs/${run.id}/`, `${id}/runs/${run.id}/compare/`);
    for (const impl of implIds) pages.push(`${id}/runs/${run.id}/${impl}/`);
  }
  for (const p of pages) {
    expectedPages++;
    if (!existsSync(pageFile(p))) fail(`missing page ${base}${p}`);
  }

  const run = d.runs.find((r) => r.id === d.default_run) ?? d.runs[0];
  if (!run) return;
  const inRun = Object.keys(run.results ?? {});
  const explorer = htmlText(read(pageFile(`${id}/`)) ?? '');
  const homeText = htmlText(home);
  for (const implId of inRun) {
    const impl = d.implementations.find((x) => x.id === implId);
    const link = `${base}${id}/${implId}/`;
    if (!explorer.includes(link)) fail(`explorer ${base}${id}/ does not link to ${link}`);
    if (impl && !explorer.includes(impl.name)) fail(`explorer ${base}${id}/ does not show "${impl.name}"`);
    if (i === 0) {
      if (!homeText.includes(`href="${link}"`)) fail(`home page does not link to ${link}`);
      if (impl && !homeText.includes(impl.name)) fail(`home page does not show "${impl.name}"`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Run-scoped pages stay inside their run
// ---------------------------------------------------------------------------------------------

/** Every JSON object inside a value, including objects encoded in JSON strings (island payloads). */
function collectObjects(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        collectObjects(JSON.parse(t), out);
      } catch {
        // not JSON
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectObjects(v, out);
  } else if (value && typeof value === 'object') {
    out.push(value as Record<string, unknown>);
    for (const v of Object.values(value)) collectObjects(v, out);
  }
  return out;
}

let scopedPagesChecked = 0;
for (const d of domains) {
  const id = d.domain.id;
  const defaultId = d.default_run ?? d.runs[0]?.id;
  const implIds = new Set([...d.implementations.map((x) => x.id), ...d.runs.flatMap((r) => Object.keys(r.results ?? {}))]);
  // Short results routes (they always show the current default run), as URL paths without query.
  const shortPages = new Set([`${base}${id}/`, `${base}${id}/compare/`, ...[...implIds].map((i) => `${base}${id}/${i}/`)]);
  for (const run of d.runs) {
    const isDefault = run.id === defaultId;
    const root = `${id}/runs/${run.id}/`;
    for (const page of [root, `${root}compare/`, ...[...implIds].map((i) => `${root}${i}/`)]) {
      const file = pageFile(page);
      const html = read(file);
      if (!html) continue; // reported as a missing page above
      scopedPagesChecked++;
      const main = html.match(/<main\b[\s\S]*<\/main>/)?.[0] ?? '';
      if (!main) fail(`${rel(file)}: no <main> element`);
      for (const m of main.matchAll(/<a\b[^>]*>/g)) {
        const tag = m[0];
        const target = decodeEntities(tag.match(/\shref="([^"]*)"/)?.[1] ?? '');
        const path = target.split(/[?#]/)[0] ?? '';
        if (shortPages.has(path) && !/\sdata-run-exit[\s=>]/.test(tag))
          fail(`${rel(file)}: link to the short results route ${target} leaves run ${run.id}`);
      }
      const saysNotDefault = htmlText(main).includes('Not the default run.');
      if (!isDefault && !saysNotDefault) fail(`${rel(file)}: does not say that it is not the default run`);
      if (isDefault && saysNotDefault) fail(`${rel(file)}: says "Not the default run." on the default run`);
      for (const pm of main.matchAll(/\sprops="([^"]*)"/g)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(decodeEntities(pm[1] ?? ''));
        } catch {
          continue; // reported below
        }
        for (const obj of collectObjects(parsed))
          if ('domainId' in obj && obj.scope !== run.id)
            fail(`${rel(file)}: island scoped to ${JSON.stringify(obj.scope)} instead of run ${run.id}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Links, forbidden tokens and structure
// ---------------------------------------------------------------------------------------------

const FORBIDDEN = /\b(NaN|undefined|Infinity)\b/;

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');

  for (const m of html.matchAll(/\s(href|src|action|poster)="([^"]*)"/g)) checkLink(decodeEntities(m[2] ?? ''), file, m[1] ?? 'link');

  // Island props: internal URLs inside serialized props (including JSON string payloads).
  for (const m of html.matchAll(/\sprops="([^"]*)"/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeEntities(m[1] ?? ''));
    } catch {
      fail(`${rel(file)}: island props are not valid JSON`);
      continue;
    }
    for (const url of collectStrings(parsed)) {
      if (!url.startsWith(base) || !/^\/[^\s"]*$/.test(url)) continue;
      if (base === '/' && !/^\/[a-z0-9_-]+\//i.test(url)) continue; // only path-like strings
      checkLink(url, file, 'island link');
    }
  }

  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const decoded = decodeEntities(visible);
  const bad = decoded.match(FORBIDDEN);
  if (bad) {
    const at = decoded.indexOf(bad[0]);
    fail(`${rel(file)} contains "${bad[0]}" near: ${decoded.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ')}`);
  }

  if (!/<title>[^<]+<\/title>/.test(html)) fail(`${rel(file)} has no <title>`);
  const h1 = (html.match(/<h1[\s>]/g) ?? []).length;
  if (h1 !== 1) fail(`${rel(file)} has ${h1} <h1> elements (expected 1)`);
}

for (const file of cssFiles) {
  const css = readFileSync(file, 'utf8');
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const u = m[1] ?? '';
    if (u.startsWith('data:') || u.startsWith('#')) continue;
    checkLink(u, file, 'CSS url()');
  }
}

for (const name of ['index.json', ...domains.map((d) => `${d.domain.id}.json`)]) {
  const served = join(dist, 'data', name);
  if (!existsSync(served)) fail(`dataset download missing: ${base}data/${name}`);
  else if (readFileSync(served, 'utf8') !== readFileSync(join(dataDir, name), 'utf8'))
    fail(`dataset download ${base}data/${name} differs from src/data/${name}`);
}

console.log(`verify: base path ${base}`);
console.log(`verify: ${htmlFiles.length} HTML pages, ${expectedPages} pages expected from the dataset, ${checkedLinks} internal links checked`);
console.log(`verify: ${scopedPagesChecked} run-scoped pages (every run, default included) checked for links that leave the run`);
if (problems.length) {
  console.error(`verify: ${problems.length} problem(s)`);
  for (const p of problems.slice(0, 200)) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('verify: OK');
