# Syna v0.4.0 source delivery

This workspace contains the complete executable reference implementation of Syna Core Semantic Model v0 and the corrected v0.4.0 API/runtime.

Included:

- `packages/core/src`: complete TypeScript source;
- `packages/core/tests`: behavior and adversarial regression tests;
- `packages/core/type-tests`: compile-time API tests;
- `apps/*`: minimal, Hyla/BASM-like, Fluida-like, and feature demos;
- `benchmarks/v0.4-planning.mjs` and `benchmarks/results-v0.4.0.json`;
- `docs/*`: semantic model, public API, architecture, package authoring, validation, and adversarial notes.

Validation gate:

```bash
npm run check
npm run test:coverage
npm run benchmark:v04
```

The source archive deliberately excludes `node_modules` and `.git`. Published-package tarballs are produced separately with `npm pack`.
