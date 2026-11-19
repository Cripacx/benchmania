/**
 * Serves the Windows installer at /install.ps1: the repository's root install.ps1, read at build time. There is
 * no copy in site/; `npm run verify` checks that dist/install.ps1 is byte-identical to the root file.
 */
import type { APIRoute } from 'astro';
import script from '../../../install.ps1?raw';

export const GET: APIRoute = () => new Response(script, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
