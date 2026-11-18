# 2. Declarative domains with a small harness interface

Date: 2026-11-18 · Status: accepted

## Context

New domains, scenarios and implementations must be addable without engine changes, and contributors should
need only Docker and Python.

## Decision

- Domains, scenarios, implementations and metrics are TOML manifests. TOML is readable, supports comments
  and is parsed by Python's standard library (no dependency).
- Domain behaviour lives in one `harness.py` per domain, implementing a six-method interface. Scenario kinds
  are defined by the harness, not by the engine.
- The metric registry (`metrics.toml`) is the single source of labels, units, direction and visibility for
  every consumer.

## Consequences

- Adding an implementation or scenario never touches Python code.
- A domain with special needs (GPU, browsers, long builds) brings its own harness without affecting others.
- The engine stays small: layout, collectors, load generators, statistics, bundles, publishing.
- `domains/_example` is the living template and the extensibility test in CI.
