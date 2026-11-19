/**
 * Serves the install guide for AI coding agents at /install.md: the repository's docs/install.md, read at build
 * time (the prompt on the home and contribute pages points agents here). `npm run verify` checks that
 * dist/install.md is byte-identical to it.
 */
import type { APIRoute } from 'astro';
import guide from '../../../docs/install.md?raw';

export const GET: APIRoute = () => new Response(guide, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
