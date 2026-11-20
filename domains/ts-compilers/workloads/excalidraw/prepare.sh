#!/bin/sh
# Runs in the checkout at image build time. Dependencies come from the lockfile, without install scripts.
# The overlay drops "baseUrl": TypeScript 6 reports it as deprecated (TS5101) and 7 as removed (TS5102).
# Nothing else changes.
set -eu
corepack yarn install --frozen-lockfile --ignore-scripts
test ! -e tsconfig.bench.json
grep -v '"baseUrl"' tsconfig.json > tsconfig.bench.json
test "$(($(wc -l < tsconfig.json) - $(wc -l < tsconfig.bench.json)))" -eq 1
