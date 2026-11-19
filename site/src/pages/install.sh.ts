/**
 * Serves the installer at /install.sh: the repository's root install.sh, read at build time. There is no copy in
 * site/; `npm run verify` checks that dist/install.sh is byte-identical to the root file.
 */
import type { APIRoute } from 'astro';
import script from '../../../install.sh?raw';

export const GET: APIRoute = () =>
  new Response(script, { headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8' } });
