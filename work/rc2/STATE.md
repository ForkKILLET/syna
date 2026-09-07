# Syna 1.0.0-rc.2 — working state

Task book `work/tasks/SYNA_RC2_EXECUTION_PROMPT.md` (goal `work/tasks/SYNA_RC2_GOAL.txt`): the examples rebuilt as seven progressive programs in one fictional domain, the fixtures rebuilt in that domain, the reference application renamed, the READMEs a facade, `docs/EXAMPLES.md` with the naming rule and the snippet-source declaration; `packages/core` untouched. Plan of record `work/rc2/DEMO_PLAN.md`; the coverage proof for the deleted demos `work/rc2/COVERAGE_CHECK.md`. Baseline 1.0.0-rc.1 = commit 4a5a978 (gate on 77d6440; `work/v1.0/STATE.md`).

## The commits

- 5b6228f `chore(tasks)`: the rc.2 task book and goal committed under `work/tasks/`; `work/rc2/DEMO_PLAN.md`, `work/rc2/COVERAGE_CHECK.md`.
- 5fee26c `build(fixtures)`, then the seven examples one commit each — 89a27ee `01-basics`, bc20553 `02-per-tenant`, 7c8feb5 `03-user-configurable`, 2d444d9 `04-two-versions`, eb37eff `05-scheduled-jobs`, b66b6d6 `06-testing`, cad6dc6 `07-failure-modes` (`feat(examples)`): `packages/notify-contract` 1.0.0, `acme-notify-v1` 1.8.4, `acme-notify-v2` 2.4.1, `globex-notify` 3.1.0, `tenant-store` 1.2.0, `logger` 1.1.0 (all `private`, scope `@syna-demo`); `apps/01-basics` … `apps/07-failure-modes` (`@syna-demo/0N-<name>`, `syna.id` `demo.examples.<name>`), each with its README, its tsconfig reference and its `npm run demo:0N`. The four old demos and the seven old fixtures deleted in 5fee26c, after the coverage proof.
- b13670a `refactor(app)`: `apps/hyla-mini` → `apps/multitenant-blog` (`@syna-app/multitenant-blog`, `bin/multitenant-blog.mjs`, `docs/MULTITENANT_BLOG.md`, `benchmarks/blog-request-latency.mjs`), behaviour unchanged line for line (`syna.id` `hyla.mini`, schema default, advisory-lock namespaces, log prefixes, manifest tag kept); the gate's `blog-*` steps, the seven `demo-0N-*` steps, `rebuild-examples`, `api-inventory-unchanged` against the 1.0.0-rc.1 record, the benchmark baseline `benchmarks/results-v1.0.0-rc.1-baseline-same-machine.json` (commit 4a5a978 for the same-session export), the `any` baseline `scripts/any-baseline-v1.0.0-rc.2.json`; the lockfile pruned of the deleted workspaces.
- 2a5f338 `docs(examples)`: both READMEs (the facade; the one-screen program cut from `02` and `03`), `docs/EXAMPLES.md`, `docs/MULTITENANT_BLOG.md` and `docs/PLUGIN_AUTHORING.md` under the application's name, `docs/API_REFERENCE.md` / `docs/PACKAGE_AUTHORING.md` examples with the examples' names, `docs/HISTORY.md`, `CHANGELOG.md`; the vendor-name scan (`scripts/lib/vendor-name-scan.mjs`, `scripts/tests/no-vendor-names.test.mjs`, the gate step `no-vendor-names`).
- 46b344f `chore(release)`: version 1.0.0-rc.2 for the workspace, `@syna/core` and `@syna/tsconfig`, every workspace pin and the lockfile (`npm install --package-lock-only`: no further change).
- The release commit (the commit that carries this ledger): the gate evidence of the execution on 46b344f — `RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.2-release/` (without its `*.log` files) — and `docs/VALIDATION.md` generated from it.

Not done and not in scope: no change under `packages/core/src`, `packages/core/tests` or `packages/core/type-tests` (`git diff --stat 4a5a978..HEAD -- packages/core/src packages/core/tests packages/core/type-tests` is empty; the only file of the package that changed is `packages/core/package.json`, the version and the tsconfig pin); no public name, semantic or default changed; nothing recorded in `docs/DEFERRED.md` — no teaching goal of the seven examples needed anything outside the frozen surface (the one point to watch, a Service opening its anchored worlds during its own setup, is the model and is shown as `OWNER_NOT_READY` in `05`); no tag, no push, no publish.

## The coverage check (`work/rc2/COVERAGE_CHECK.md`)

The four assertions of `features-demo` — an eager Service starts during Entry activation, a destructured dependency reference is still lazy, a structural cycle is callable after setup, a setup wait cycle is refused with `LOAD_TIMEOUT` — are each a named case of an existing core test (`packages/core/tests/v05-cache-cleanup.test.mjs` K09, `lifecycle.test.mjs`, `contracts.test.mjs`, `core.test.mjs`, `v05-promises.test.mjs` R04, `hardening.test.mjs`), run and green on the rc.1 tree before the demo was deleted; the assertions of `minimal-demo`, `hyla-demo` and `fluida-demo` map to core tests and to `01`, `03`/`04` and `05`. Conclusion: no gap; nothing to add for the deletions. The wait-cycle diagnostic is shown again in `07-failure-modes` because a reader asking what happens when a setup hangs should see `suspectedWaitCycle`.

## The release gate on 46b344f — COMPLETE

`node scripts/verify-release.mjs --release` alone, nothing else running (log in the session scratchpad):

- `COMPLETE`, started 2026-09-07T07:39:15.574Z, generated 2026-09-07T07:43:16.968Z, 52 steps ok of 52, 902 test executions (451 distinct cases, 451 re-executed in the rebuilt copy), 902 passed, 0 failed steps, 0 skipped; source fingerprint `03bc54697bf475332a54286907da2dcb4bd67ffa17a6598fb4bd20ef38cd5f1e` (366 files); provenance commit 46b344f896244065935b9ccd029417dc264c4958, `dirty: false`, `modified: []`, `untracked: []`; PostgreSQL 17.10 on a temporary cluster at 54329.
- `api-inventory-no-deprecated`: 374 items, 0 @deprecated. `api-inventory-diff` against the 1.0.0-rc.1 record: 374 in the record, 374 here — 0 added, 0 removed, 0 changed in signature, 0 changed in JSDoc only, 0 newly deprecated. `api-inventory-unchanged` (1.0.0-rc.1 record, commit 77d6440) and `api-inventory-frozen` (0.8.0 record, commit 38a722e): 0 of the record's items changed or removed, 0 new or changed, 374 = 374.
- `no-old-reference-tokens`: 56 files scanned, 0 hits. `no-vendor-names`: 226 files scanned, 0 hits, 12 allowed literals of the application (all under `apps/multitenant-blog/` and `docs/MULTITENANT_BLOG.md`; `vendor-name-scan.json`). `any-count` OK against `scripts/any-baseline-v1.0.0-rc.2.json` (178, the 0.7.0 count; the examples and fixtures use none). `codemod-idempotent` and `rebuild-codemod-idempotent`: 0 edits, 0 hand sites. `gate-self-tests` 30 / 30 (the README program compiled and run as printed, the inventory identities, the vendor-name scan, the re-keyed `any` baseline against the 0.7.0 record).
- The seven examples: `demo-01-basics` … `demo-07-failure-modes` ok, each with every stable line of its README and its `<name>: OK` line; `rebuild-examples` (`npm run demo` inside the unpacked archive) prints all seven `OK` lines. `blog-demo-filesystem` and `rebuild-demo`: HTTP alpha 200 (1000 bytes), HTTP beta 200 (933 bytes), static alpha 200 (6 files), `demo: OK`.
- `benchmark-compare` (same session against 4a5a978, both sides under `--expose-gc --no-maglev`, 21 rounds): 23 / 23 tolerance rows within ±10 % (largest delta +5.8 %, `cases.phase-breakdown-300.materializationMs.p50Ms`; the formerly bimodal `site-enter-tenant-input-reverse-closure-200` p95 −0.6 %, 0.2873 → 0.2857 ms), 116 / 116 equality rows equal. Record drift (informational, this session's 1.0.0-rc.1 side against `benchmarks/results-v1.0.0-rc.1-baseline-same-machine.json`): 116 / 116 equal, 20 / 23 within ±10 % — the three outside are the sub-0.1 ms `phase-breakdown-300` rows (materialization p50 −25.8 %, p95 −16.8 %, dispose p50 −14.6 %), the machine two hours later, not the code (the same source on both sides of that check).
- Working set (H11): at most 6 site Envs alive of capacity 6.
- Archives (`validation/v1.0.0-rc.2-release/SHA256SUMS.txt`):
  - `work/release/syna-v1.0.0-rc.2-source.tar.gz` 836669 bytes sha256 `4ee5915776a2d2318ad3e1c12dd7f6fee8a9b5d713d365c042d0510a5a6223bd`
  - `work/release/syna-v1.0.0-rc.2-source.zip` 1052523 bytes sha256 `37ff26de0ff6a6ad95aaa04c2d39e04deedb339779ca7c2d6a1190d131e427a4`
  - `work/release/pack/syna-core-1.0.0-rc.2.tgz` 112554 bytes sha256 `c5ec21120dfc2683f37009f4b7e7c16439aecee0bd9beaf5bac7dce6adafaf1e`
  - `work/release/pack/syna-tsconfig-1.0.0-rc.2.tgz` 1574 bytes sha256 `f4f2ea9918b3399bd7f8d82e0c37eb4899af9636afc9519b47c9f07318b7a3e9`
- Consumer smoke: `{"result":84,"revision":"7.3.1","explainOk":true,"missing":"smoke.consumer/input/answer/v1","abandoned":0,"revisions":"7.3.1","slots":"ready,ready"}`.
- `docs/VALIDATION.md` generated from this manifest by `node scripts/validation-doc.mjs`; `RELEASE_MANIFEST.json` is this manifest.

## Acceptance (the goal's success conditions, each with its evidence)

- `git diff` for the core empty: `packages/core/src`, `tests`, `type-tests` unchanged since 4a5a978 (above); `packages/core/package.json` carries the version only.
- Inventory 0 added / 0 removed / 0 changed against the 1.0.0-rc.1 record: `api-inventory-diff` and `api-inventory-unchanged`; identical to the 0.8.0 record: `api-inventory-frozen`; asserted again by `scripts/tests/api-inventory.test.mjs` inside `gate-self-tests` and `rebuild-gate-self-tests`.
- Planner differential and explain/inspect snapshots verbatim: `reference-planner.test.mjs` and `v06-snapshots.test.mjs` inside `core-tests` (243 / 243) and `rebuild-core-tests`, the suites unchanged since 0.8.0.
- Seven examples runnable, self-asserting, non-zero on failure (each program's `assert` calls; verified during the build by breaking an expectation and watching exit 1), each a gate step with its stable lines, each README opening with the problem it solves.
- Fixtures rebuilt per the list, `private: true`, fictional vendors; `OpenAI` / `Claude` / `hyla-mini` zero hits outside the historical documents and `work/**`: `no-vendor-names`.
- Reference application renamed, all its tests green (`blog-*` steps, `rebuild-app-tests` 133 / 133, `rebuild-postgres-matrix-tests` 45 / 45), the four-cell assertions kept (`blog-demo-filesystem`, `rebuild-demo`; the fourth cell, PostgreSQL, is the matrix suite's HTTP and static cells on the PostgreSQL backend).
- `docs/EXAMPLES.md`, `docs/MULTITENANT_BLOG.md`, `docs/HISTORY.md`, `CHANGELOG.md`, both READMEs, version 1.0.0-rc.2: commits 2a5f338 and 46b344f.
- All core / type / app / scripts tests and the real PostgreSQL matrix: the steps above.
- Benchmark within ±10 % and equal counters against 1.0.0-rc.1, same machine, interleaved: `benchmark-compare`.
- `any` not increased: `any-count`, 178 = 178.
- Gate from the final archive: unpack, `npm ci`, build, the must-run suites, the examples and the demo, pack, consumer smoke — `COMPLETE`, exit 0, provenance `dirty: false`.
- No tag, no push, no publish.

## Reproduce

- Suites: `npm run typecheck && npm test && npm run test:scripts && npm run test:app && npm run test:postgres && npm run demo && npm run demo:multitenant-blog` (then `git checkout -- work/v05/working-set.json; rm -rf work/demo-content`).
- Gate: `node scripts/verify-release.mjs --release` alone (about four minutes; PostgreSQL 17 binaries or `SYNA_TEST_PG_URL`; the git history with 4a5a978 for the same-session comparison, else the recorded file on this machine). Then `node scripts/validation-doc.mjs` and commit `RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.2-release/` and `docs/VALIDATION.md` together; the step logs stay untracked (`*.log`).
- The vendor-name scan by hand: `node --test scripts/tests/no-vendor-names.test.mjs`; the allowed literals and their reasons are `ALLOWED_LITERALS` in `scripts/lib/vendor-name-scan.mjs`.
- Inventory identity by hand: `node scripts/api-inventory.mjs --json <file>` and compare `items` with `validation/v1.0.0-rc.1-release/api-inventory.json` and `validation/v0.8-release/api-inventory.json`.
