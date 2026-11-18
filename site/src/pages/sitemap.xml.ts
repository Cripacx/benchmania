/** A small sitemap of every generated page (only emitted with absolute URLs when a site origin is known). */
import type { APIRoute } from 'astro';
import { allDomains } from '../lib/dataset';
import { absoluteUrl, href, routes } from '../lib/paths';

export const GET: APIRoute = ({ site }) => {
  const paths = [routes.home(), routes.methodology(), routes.machines(), routes.contribute(), routes.data()];
  for (const d of allDomains()) {
    const id = d.domain.id;
    paths.push(routes.domain(id), routes.compare(id), routes.runs(id));
    for (const i of d.implementations) paths.push(routes.implementation(id, i.id));
    for (const r of d.runs) paths.push(routes.run(id, r.id));
  }
  const urls = paths
    .map((p) => absoluteUrl(site, href(p)) ?? href(p))
    .map((u) => `  <url><loc>${u.replace(/&/g, '&amp;')}</loc></url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
