#!/bin/sh
# Runs in the checkout at image build time. Dependencies come from the lockfile, without install scripts.
# The overlay switches module resolution to nodenext: the repository's node10 setting is deprecated in
# TypeScript 6 (TS5107) and removed in 7 (TS5108), so no tool would accept the unchanged tsconfig.
set -eu
corepack pnpm install --frozen-lockfile --ignore-scripts
test ! -e packages/typeorm/tsconfig.bench.json
cp "$(dirname "$0")/tsconfig.bench.json" packages/typeorm/tsconfig.bench.json
