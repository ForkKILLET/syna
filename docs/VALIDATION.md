# Validation

The final v0.4 workspace is validated with:

```bash
npm run check
npm run test:coverage
npm run benchmark:v04
```

## Gate result

- strict TypeScript project build: passed;
- compile-time positive and negative API tests: passed;
- Node runtime behavior tests: **88 passed, 0 failed, 0 skipped**;
- minimal, Hyla/BASM-like, Fluida-like, and feature demos: passed.

The adversarial suite covers selector cache cardinality, stable candidate templates, bounded eviction, `load()` barriers versus `preload()`, direct and indirect materialization cycles, retry cancellation, retry-on-next-load, coherent definition overrides, private Service-owned Entry realms, activation-time child Entries and rollback, Binding cache isolation, topology preflight, async disposal, SCC behavior, and structured error suppression.

## Coverage

The final built-in Node coverage output is included at `validation/v0.4-final/coverage.log`. Coverage is a regression signal, not a proof of the semantic model; the adversarial state-transition tests are treated as the stronger gate.

## Planning benchmark

`benchmarks/v0.4-planning.mjs` records seven paths in `benchmarks/results-v0.4.0.json`:

- 100- and 300-Service request graphs at ancestor depths 2 and 6;
- request-local selector with three candidates;
- request-local Binding alternating between two choices;
- 500 distinct Entry shapes against a 16-entry LRU.

On the recorded Node v22.16.0 Linux x64 run:

```text
selector, 3 candidates, 1100 total invocations:
  cache hits 4396, misses 5, entries 5

Binding, 2 alternating choices, 1100 total invocations:
  cache hits 1098, misses 3, entries 3

500 distinct Entry shapes, maxEntries=16:
  entries 16, evictions 484
```

Latency numbers are machine-specific. Cache cardinality, stable miss counts, and bounded growth are the portable assertions.

## Distribution validation

The delivery procedure packs `@syna/core` and `@syna/tsconfig`, installs them into a clean smoke project, imports that project's own `package.json` through `#syna/package`, compiles, and executes a minimal Runtime/Entry program.
