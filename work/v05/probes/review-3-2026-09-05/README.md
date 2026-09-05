# Third review round probes (2026-09-05)

The two auditors' minimal programs of the third round, rewritten as standalone probes and run against the fixed build (`npm run build` first). Each prints `PASS`/`FAIL` lines and exits 1 on any failure. Regression tests cover the same ground inside the suites; these are the reproductions kept for the record (`docs/AUDIT.md`, "Third review round").

| probe | finding | fixed by |
|---|---|---|
| `p1-range-only-private.mjs` | C1 a private Family referenced only by `range()` was `MISSING_SERVICE` | I-58 (range origin) |
| `p2-anchor-cache.mjs` | C3 plan templates shared between gap Envs with different lineage anchors (order-dependent plans) | I-60 (anchors digest in the key) |
| `p3-dispose-before-deadline.mjs` | C4 `dispose()` before a deadline that fired inside the grace hid the attempt | I-61 |
| `p4-capacity-2-starvation.mjs` | S2 a redundant reservation was released without waking the queue | I-66 |
| `p5-same-id-two-tenants.mjs` | B1 same post id in two tenants refused on PostgreSQL | I-78 (PostgreSQL part runs with `SYNA_TEST_PG_URL`, e.g. through `scripts/pg-test-cluster.mjs with --`) |
| `p6-concurrent-domain-claim.mjs` | B2 concurrent domain claims both succeeded | I-79 (same PostgreSQL note) |
| `p7-symlink-escape.mjs` | T1 symbolic links under the static output written through and served | I-76 |
| `p8-fetch-host.mjs` | D1 `fetch()` drops the `Host` header (the demo's 404 cells); `node:http` serves the tenant | I-82 |

Run: `for p in work/v05/probes/review-3-2026-09-05/p*.mjs; do node "$p"; done` and, for the PostgreSQL parts, `node scripts/pg-test-cluster.mjs with -- node work/v05/probes/review-3-2026-09-05/p5-same-id-two-tenants.mjs` (same for p6). Result on the fixed source (commit 82114fc): all PASS on both backends.
