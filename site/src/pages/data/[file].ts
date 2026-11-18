/**
 * Serves the dataset files byte for byte as static downloads: /data/index.json, /data/<domain>.json.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { rawDataFiles } from '../../lib/dataset';

export const getStaticPaths = (() =>
  rawDataFiles().map((f) => ({ params: { file: f.name }, props: { content: f.content } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(String(props.content), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
