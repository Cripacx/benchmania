# 1. One repository in a dedicated GitHub organization

Date: 2026-11-18 · Status: accepted

## Context

The platform consists of an engine, domains with many implementations, result data, a website and
documentation. Contributors range from people adding one framework to people adding a whole domain.

## Decision

A dedicated GitHub organization named after the project, holding one monorepo.

## Reasons

- An organization gives the project a neutral identity, teams and CODEOWNERS per domain, and survives
  changes of maintainers.
- A monorepo lets one pull request change the schema, the engine and the website together, gives
  contributors one clone and one guide, and needs one CI configuration. TechEmpower and HttpArena show that
  this scales to hundreds of implementations.
- Splitting repositories now would require versioned interfaces between them before they are stable.

## Consequences

- CI uses path filters so a change to one implementation only builds that implementation.
- Result bundles live in `results/` with a stable, versioned format. When community submissions make the
  repository heavy, `results/` moves to its own repository without format changes.
