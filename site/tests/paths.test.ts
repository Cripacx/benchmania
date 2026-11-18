import { describe, expect, it } from 'vitest';
import { absoluteUrl, joinBase, normalizeBase, routes } from '../src/lib/paths';

describe('base path handling', () => {
  it('normalizes base paths', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('benchmania')).toBe('/benchmania/');
    expect(normalizeBase('/benchmania')).toBe('/benchmania/');
    expect(normalizeBase(' /a/b/ ')).toBe('/a/b/');
  });

  it('joins the base with site-relative paths', () => {
    expect(joinBase('/', '/backend/')).toBe('/backend/');
    expect(joinBase('/repo/', '/backend/')).toBe('/repo/backend/');
    expect(joinBase('/repo', 'favicon.svg')).toBe('/repo/favicon.svg');
    expect(joinBase('/repo/', '/')).toBe('/repo/');
    expect(joinBase('/repo/', routes.compare('backend', ['a', 'b']))).toBe('/repo/backend/compare/?ids=a,b');
  });

  it('builds routes with trailing slashes', () => {
    expect(routes.domain('backend')).toBe('/backend/');
    expect(routes.implementation('backend', 'rust-axum')).toBe('/backend/rust-axum/');
    expect(routes.run('backend', '20261117T2323Z-d82776-legacy')).toBe('/backend/runs/20261117T2323Z-d82776-legacy/');
    expect(routes.compare('backend')).toBe('/backend/compare/');
    expect(routes.dataFile('backend.json')).toBe('/data/backend.json');
    expect(routes.contribute()).toBe('/contribute/');
    expect(routes.contribute('submit')).toBe('/contribute/#submit');
    expect(joinBase('/repo/', routes.contribute('submit'))).toBe('/repo/contribute/#submit');
  });

  it('builds absolute URLs only when an origin is known', () => {
    expect(absoluteUrl(new URL('https://example.org'), '/repo/backend/')).toBe('https://example.org/repo/backend/');
    expect(absoluteUrl(undefined, '/x/')).toBeUndefined();
  });
});

describe('run-scoped routes', () => {
  it('mirror the default routes under /<domain>/runs/<run>/', () => {
    expect(routes.implementation('backend', 'rust-axum', 'r1')).toBe('/backend/runs/r1/rust-axum/');
    expect(routes.compare('backend', ['a', 'b'], 'r1')).toBe('/backend/runs/r1/compare/?ids=a,b');
    expect(routes.compare('backend', [], 'r1')).toBe('/backend/runs/r1/compare/');
    expect(routes.explorer('backend', 'r1')).toBe('/backend/runs/r1/');
  });
  it('fall back to the canonical short routes without a scope', () => {
    expect(routes.implementation('backend', 'rust-axum', null)).toBe('/backend/rust-axum/');
    expect(routes.compare('backend', ['a'], null)).toBe('/backend/compare/?ids=a');
    expect(routes.explorer('backend')).toBe('/backend/');
  });
});
