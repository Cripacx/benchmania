import type { APIRoute } from 'astro';
import { absoluteUrl, href } from '../lib/paths';

export const GET: APIRoute = ({ site }) => {
  const sitemap = absoluteUrl(site, href('sitemap.xml'));
  const body = ['User-agent: *', 'Allow: /', ...(sitemap ? [`Sitemap: ${sitemap}`] : [])].join('\n');
  return new Response(`${body}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
