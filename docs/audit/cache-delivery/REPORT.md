# Independent review — cache / delivery / developer experience (Syna v0.5 + Hyla-mini)

> Archived copy of the reviewer's report. Two strings were altered so that the source-archive scan (which rejects absolute home paths and `user:password@` connection strings) stays clean: a placeholder connection-string pattern in the unpack row is now described in words, and an elided absolute home path in the F-CD-08 section is spelled `<home>/…`. Nothing else differs from the reviewer's working copy `work/v05/audit/cache-delivery/REPORT.md` (outside the archive).

Reviewer line: plan-cache neutrality (R17), long churn (R18/P04), benchmarks and budgets (P01–P03, P07), archive rebuild in a clean directory (G1), a real TypeScript consumer, deprecated paths, and whether `scripts/verify-v05.mjs` is a transparent runner.

I did not write this code and was given no claim about its correctness. Everything below that says PASS or a number was run by me; anything I only read is marked "by inspection". No file under `packages/`, `apps/`, `docs/`, `scripts/`, `benchmarks/` was modified (`git status --porcelain -- packages apps docs scripts benchmarks` → 0 lines). All artefacts live under `work/v05/audit/cache-delivery/` (this directory).

## 0. Source under review and drift during the review

- Reviewed commit: **`e2a6c73a591c6fb80f60562bfad4e3cc1686301e`** ("docs: validation summary generated from the dev-gate manifest"). `git archive --format=tar HEAD` was extracted into a fresh `mktemp -d` directory; its file list is byte-for-byte the HEAD tree (`diff <(git ls-tree -r --name-only HEAD) <(find archive)` → empty, 194 files).
- The working tree moved while I worked: when I started, HEAD was `0240b6f` and `docs/SEMANTIC_CHANGES_V05.md`, `docs/MIGRATION_V04_TO_V05.md`, `benchmarks/results-v0.4.0-baseline-same-machine.json`, `validation/v0.5-dev/**` were **untracked**; three commits (`d6c7541`, `397180e`, `e2a6c73`) landed before my archive step and included them. All probes ran against `packages/core/dist` built from the working tree, whose fingerprinted files were identical to `e2a6c73` at probe time (replicated fingerprint `5c63c72d…`, 179 files, equal for the working tree and the extracted archive after a build).
- Two other audit lines (`work/v05/audit/promise-lifecycle/`, `work/v05/audit/app-permissions/`) were active concurrently; their probes and any PostgreSQL clusters they started are not covered here. My only PostgreSQL cluster command ran alone, from the scratch copy, on its own data directory.

## 1. Environment

| item | value |
|---|---|
| Host | Darwin 25.2.0 arm64, Apple M4 Pro × 14, 48 GiB (from `uname`, `sysctl`, benchmark JSON) |
| Node / npm | v26.0.0 / 11.12.1 (`packageManager` field says `npm@11.12.1`; `engines.node >=22`) |
| V8 | 14.6.202.33-node.19 |
| PostgreSQL | Homebrew binaries found by `scripts/pg-test-cluster.mjs` (`/opt/homebrew/opt/postgresql@17`), temporary cluster on 127.0.0.1:54329 |
| TypeScript | ~5.9.3 (workspace pin; the consumer installed the same range) |
| Scratch | `mktemp -d` → `/tmp/syna-cd-audit-*`, deleted at the end of the review |

Timing numbers were recorded while other audit processes may have been running on the same host (the implementer's VALIDATION.md carries the same caveat).

## 2. Commands, exit codes, counts

### 2.1 Archive rebuild in a clean directory (G1, my own run — logs in `rebuild-logs/`)

Driver: `rebuild-logs/../rebuild.sh` (copied verbatim into `rebuild-logs/rebuild.log` headers). Executed from the extracted archive `<scratch>/src`.

| step | command | exit | result |
|---|---|---|---|
| unpack | `git -C … archive --format=tar HEAD \| tar -x -C <scratch>/src` | 0 | 194 files; no `dist/`, no `node_modules/`, no `*.tsbuildinfo`; absolute-home-path scan hits only `validation/v0.5-dev/manifest.json` (see F-CD-08); no credential-bearing `postgres://` connection strings |
| install | `npm ci --no-fund --no-audit` | 0 | "added 127 packages in 482ms" (offline cache); `package-lock.json` sha256 `4b1a2427…3196` **identical before and after** |
| build | `npm run build` | 0 | `tsc -b packages/core --force && tsc -b tsconfig.json --force` |
| type tests | `npm run type-tests` | 0 | `tsc -p packages/core/tsconfig.type-tests.json --pretty false`, no output |
| core tests | `node --test --test-reporter=tap packages/core/tests/<17 files>` | 0 | `# tests 130 / pass 130 / fail 0 / cancelled 0 / skipped 0 / todo 0` |
| app fs+render | `node --test --test-reporter=tap apps/hyla-mini/tests/filesystem.test.mjs apps/hyla-mini/tests/render.test.mjs` | 0 | `# tests 47 / suites 5 / pass 47 / fail 0 / skipped 0` |
| PostgreSQL | `SYNA_PG_CLUSTER_DIR=<scratch>/pg node scripts/pg-test-cluster.mjs with -- node --test --test-reporter=tap apps/hyla-mini/tests/postgres.test.mjs` | 0 | cluster started on 54329; `# tests 22 / suites 2 / pass 22 / fail 0 / skipped 0`; "stopped", "removed <scratch>/pg" |

(`--test-reporter=tap` was added to the prescribed commands so counts could be parsed; the file lists are the ones the task named.)

### 2.2 Package tarballs and an independent TypeScript consumer (`consumer/`, `consumer-logs/`)

| step | command (cwd) | exit | result |
|---|---|---|---|
| pack | `npm pack --pack-destination <scratch>/pack <scratch>/src/packages/core` and `…/packages/tsconfig` | 0 | `syna-core-0.5.0.tgz` (84 397 B), `syna-tsconfig-0.5.0.tgz` (1 483 B). Core tarball contains only `package/{LICENSE,package.json,README.md}` + `package/dist/**` (`.js`, `.d.ts`, maps); 0 files matching `src/`, `tests/`, `tsbuildinfo`; no absolute paths; shipped `dist/descriptors.d.ts` carries `@deprecated` on `Contract.selector`, `ImplementationSelectorDependency`, `ImplementationSelector`, `InputRef.load` |
| install | `npm install --no-fund --no-audit --prefer-offline` (consumer) | 0 | "added 6 packages"; `@syna/core 0.5.0` with `dependencies {"semver":"^7.8.5"}` resolved |
| compile | `tsc -p tsconfig.json` (extends `@syna/tsconfig/node-app.json`, imports `#syna/package` via `imports`) | 0 | no diagnostics — program uses `definePackage(packageJson)`, `InputRef.read()`, `load({ signal })`, `explain()`, `loadAll`, and the deprecated `inputRef.load()` and `Contract.selector` |
| run | `node dist/index.js` | 0 | `{"result":{"out":"hi world\|hi x\|7\|true","candidates":["audit.consumer/greeter@3.2.1"]},"version":"3.2.1","key":"audit.consumer/greeter@3.2.1","packageId":"audit.consumer","explainOk":true,"services":{"inherited":0,"new":3,"forked":0,…},"missing":{"code":"MISSING_INPUT","inputs":["audit.consumer/input/deferred/v1"]},"cancelled":"LOAD_CANCELLED"}` — package version auto-injected, Promise payload returned by identity from `read()`, deprecated `load()` awaited it to `7`, pre-aborted signal → `LOAD_CANCELLED` |
| negative compile | `tsc -p tsconfig.neg.json` on `neg/loadall-input.ts` | **2 (expected non-zero)** | `TS2741: Property 'preload' is missing in type 'InputRef<…>' but required in type 'DependencyRef<unknown>'` for `loadAll({ config })`; `TS2339: Property 'read' does not exist on type 'DependencyRef<…>'` for `minimal.read()` |

### 2.3 Benchmarks (`bench-audit.json`, `bench-audit.stdout`, `bench-tightened-budgets.*`)

| command | exit | result |
|---|---|---|
| `node --expose-gc benchmarks/v0.5-planning.mjs /tmp/bench-audit.json` | 0 | `budgetsOk: true`; environment block has node, v8, platform, OS release, arch, CPU model, CPU count, memory, `gcExposed`, `nodeOptions`; `core: @syna/core 0.5.0`; `methodology.warmupIterations: 50`; per case `timing.samples` (500/300), `warmup`, `min/p50/p90/p95/p99/max/mean`, `heapDeltaBytes` |
| `node --expose-gc benchmarks-tight/v0.5-planning.mjs … --quick` (verbatim copy of the script next to a tightened `budgets.json`: `warm-enter-dispose-300-depth-2 p95Ms ≤ 0.000001`, plus a budget naming a non-existent case) | **3 (expected)** | `budgetsOk:false`; the impossible budget `ok:false` (value 0.351 ms); the non-existent case also `ok:false` (missing metric is a failure, not a silent pass) |

Measured values (this run):

| case | samples | p50 ms | p95 ms | p99 ms | plan-cache entries | notes |
|---|---|---|---|---|---|---|
| warm-enter-dispose-100-depth-2 | 500 | 0.095 | 0.165 | 0.215 | 4 | request shape: 100 inherited + 20 new services, 1 inherited + 1 provided input |
| warm-enter-dispose-100-depth-6 | 500 | 0.080 | 0.141 | 0.177 | 8 | |
| warm-enter-dispose-300-depth-2 | 500 | 0.196 | **0.301** | 0.374 | 4 | budget 2 ms (P03); 260 inherited + 60 new services |
| warm-enter-dispose-300-depth-6 | 500 | 0.191 | 0.288 | 0.351 | 8 | |
| phase-breakdown-300 (n=60) | 60 | — | cold+new slots 21.0 / warm 0.397 / materialize 0.063 / dispose 0.045 | — | — | cold = 3 nested `enter`s incl. all slot allocation |
| site-enter-tenant-input-reverse-closure-200 | 300 | 0.156 | 0.244 | 0.399 | 2 | inherited 140 |
| bound-entry-private-range-enter-dispose | 500 | 0.014 | 0.020 | 0.027 | 2 | **one-node graph** (see F-CD-07) |
| override-and-all-request-enter-dispose-100 | 500 | 0.081 | 0.135 | 0.177 | — | |
| churn-10000-requests | 10 000 ops | 0.0878 ms/op | — | — | max 4 | live Envs after 2; heap after gc 7.08→7.35 MB across 5 samples |
| lru-churn-500-shapes | — | — | — | — | 16 (500 misses, 484 evictions) | 1-service world |

Committed run (`validation/v0.5-dev/benchmark-v0.5.json`) reproduces within noise (300-depth-2 p95 0.305 vs 0.301 here).

Same-machine v0.4 comparison (both files committed, both Node v26 on this host; `results-v0.4.0-baseline-same-machine.json` = v0.4 workload on v0.4 core, `results-v0.4-workload-on-v0.5-same-machine.json` = same script on v0.5 core; recomputed by me):

| v0.4 workload case | v0.4 core p95 ms | v0.5 core p95 ms | ratio |
|---|---|---|---|
| request-chain-100-depth-2 | 0.1484 | 0.1816 | +22 % |
| request-chain-100-depth-6 | 0.0708 | 0.0926 | +31 % |
| request-chain-300-depth-2 | 0.3040 | 0.3363 | +11 % |
| request-chain-300-depth-6 | 0.3230 | 0.3495 | +8 % |
| selector-request-3-candidates | 0.0563 | 0.0720 | +28 % |
| binding-request-2-choices | 0.0234 | 0.0289 | +23 % |

### 2.4 Orchestrator transparency (`orchestrator-sim/`, `orchestrator-sim-blocked.stdout`)

| command | exit | result |
|---|---|---|
| `node scripts/verify-v05.mjs --dev` in the rebuilt scratch copy, with `work/pg-dev` pre-created as a **regular file** so `pg-test-cluster.mjs start()` cannot `mkdir` | **3 (expected: BLOCKED)** | 11 steps ok, `FAIL hyla-postgres-and-matrix-tests (exit 1, 61 ms)`, log = `EEXIST: file already exists, mkdir '<scratch>/src/work/pg-dev'`; manifest `status: "BLOCKED"`, `blocked:[{step, reason:"PostgreSQL could not be started or reached…"}]`, totals 192/192 tests (217 − 25 PostgreSQL/matrix), `gitProvenance: {commit:null, dirty:null, note:"not a git repository…"}`, fingerprint `5c63c72d…` (179 files) — identical to the fingerprint of the untouched HEAD tree computed independently |
| `node --test --test-reporter=tap fixture.test.mjs` (1 pass, 1 `{skip:true}`, 1 `{todo:true}` that fails) | **0** | `# tests 3 / pass 1 / fail 0 / cancelled 0 / skipped 1 / todo 1` |
| same, one test that hangs past `timeout: 50` | 1 | `# cancelled 1` (exit code covers cancelled) |
| `exit-vs-close.mjs` (replica of `run()` collecting chunks and finalizing on `'exit'`; child writes 8 MiB then the TAP summary) | 0 | 5/5 `'exit'` runs and 5/5 `'close'` runs captured the full 8 388 628 bytes including `# tests 1` → not reproduced |
| `list-source-files.replica.mjs` (verbatim copy of `listSourceFiles()`/`fingerprint()` from the script) on the built scratch tree and on the working tree | 0 | both: `{"count":179,"digest":"5c63c72d…"}`; list contains no `dist/`, `node_modules`, `.tsbuildinfo`, `.log`, `manifest`, or `validation/v0.5-*` entry; only `validation/README.md` from `validation/` |

Cross-check of committed evidence: `validation/v0.5-dev/logs/core-tests.log` ends `# tests 130 / pass 130 / fail 0 / cancelled 0 / skipped 0 / todo 0` and has 130 `ok` lines / 0 `not ok`; `hyla-postgres-and-matrix-tests.log` starts `started: postgres://syna@127.0.0.1:54329/postgres`, ends `# tests 25 / pass 25 / fail 0 / skipped 0`, then `stopped` / `removed …/work/pg-dev`. Both match `manifest.json` (130/130, 25/25).

### 2.5 Probes (this directory; each prints PASS/FAIL per case and exits 0 only when all pass)

| probe | command | exit | summary |
|---|---|---|---|
| `01-cache-neutrality.probe.mjs` | `node 01-…` | 1 | 11 PASS / **1 FAIL** (the FAIL is F-CD-02, not a neutrality failure). Stats: maxEntries 512 → hits 187 / misses 65 / evictions 0; maxEntries 1 → hits 109 / misses 143 / evictions 88; maxEntries 4 + 5 distinct filler shapes before every real `enter` → misses 428 / evictions 364. **278 structural records identical** across the three runs |
| `01b-r17-details.probe.mjs` | `node 01b-…` | 0 | detail dump (Layer re-provision forks Panel only; share violation) |
| `01c-backtracking-wraps-diagnosis.probe.mjs` | `node 01c-…` | 1 | 1 PASS / 5 FAIL → F-CD-01, F-CD-02 |
| `01d-missing-binding-explain.probe.mjs` | `node 01d-…` | 1 | 2 PASS / 2 FAIL → F-CD-01 |
| `02-churn.probe.mjs` | `node --expose-gc 02-…` | 0 | 9 PASS (12 000 mixed ops + 1 100-shape LRU stress) |
| `03-semver-binding.probe.mjs` | `node 03-…` | 0 | 24 PASS |
| `04-template-size.probe.mjs` | `node --expose-gc 04-…` | 0 | measurement for F-CD-04 |

## 3. Findings

Severity vocabulary: blocking / major / minor / limitation; "uncertain" = not reproduced.

### F-CD-01 — `explain()` reports `missingInputs: []` / `missingBindings: []` when the missing parameter is required by a Service inside the graph rather than declared on the Entry — **major** (K12 diagnostics, main path)

- Trigger: an Entry whose `requires` closure contains a Service needing Input `X` (or Binding `B`) while no Env in the lineage provides it and the Entry does not declare it as a parameter. `runtime.explain(Entry)`.
- Expected: K12 — "至少输出：… 缺失输入、不可满足约束"; §12 — "错误码 union、实际 throw 和诊断 schema 保持一致". `explain()` returning `ok:false` must list the missing Input id in `missingInputs` (Binding in `missingBindings`).
- Actual (`01d-missing-binding-explain.out`): `deep (undeclared) Input: MISSING_INPUT missingInputs=[] missingBindings=[] details.missing=["audit.mb/input/tenant/v1"]`; `deep (undeclared) Binding: MISSING_BINDING missingInputs=[] missingBindings=[] details.missing=["audit.mb/binding/choice/v1"]`. The declared-but-unprovided cases populate the arrays correctly.
- Cause (by inspection): `RuntimeImpl.explainFrom` (`packages/core/src/runtime.ts` 446–448) copies `error.details.missingInputs`/`missingBindings`; `EntryPlanner.plan` sets those keys only for declared parameters (`entry-planner.ts` 192–206), while `GraphBuilder` raises `MISSING_INPUT`/`MISSING_BINDING` with `{ input|binding, site, missing }` (`graph-builder.ts` 142–147, 165–170). Fix is local: read `details.missing` too (or emit both keys from the builder).
- Scope: `explain()` schema consumers (preflight tooling, Hyla-mini `explain` CLI); `enter()` error code is correct; cache-neutral.

### F-CD-02 — candidate backtracking misattributes candidate-independent failures to `UNSATISFIABLE_TOPOLOGY "No candidate can satisfy auto(...)"`, and the reported code depends on the declaration order of unrelated `requires` keys — **major** (K12 error-code stability)

- Trigger: the graph contains an unresolved choice site (`auto(C)`, `Family.range()`, naked Contract) that `GraphBuilder` reaches **before** a node whose failure has nothing to do with the choice: a `share:[Cache]` violation caused by a re-provided Input, or a deep missing Input/Binding.
- Expected: K12 — "无法解析的候选可以回溯；policy TypeError、无效 descriptor、内部 bug 不可吞为 UNSAT"; the diagnosis of a constraint/missing-input failure must not change because an unrelated `auto()` happens to sit earlier in `requires`. §12 — codes must be stable.
- Actual (`01c-backtracking-wraps-diagnosis.out`):
  - `share-only: enter=SHARE_CONSTRAINT_FAILED explain=SHARE_CONSTRAINT_FAILED` but `share-with-auto: enter=UNSATISFIABLE_TOPOLOGY explain=UNSATISFIABLE_TOPOLOGY nested=["SHARE_CONSTRAINT_FAILED","SHARE_CONSTRAINT_FAILED"]`, message "No candidate can satisfy auto(audit.wrap/capability/v1) at service:audit.wrap/auto-user@1.0.0/dependency:automatic" — every candidate failed with the same share violation; no candidate could ever satisfy it.
  - `missing-auto-first: UNSATISFIABLE_TOPOLOGY nested=["MISSING_INPUT","MISSING_INPUT"] missingInputs=[]` versus `missing-auto-last: MISSING_INPUT` — identical Entries except for the order of the two `requires` keys.
  - Reproduced in the full world by `01-cache-neutrality.probe.mjs` ("K12 share:[Cache] … — enter() threw UNSATISFIABLE_TOPOLOGY; explain() code UNSATISFIABLE_TOPOLOGY").
- Cause (by inspection): `solvePlanTemplate` (`entry-planner.ts` 476–507) catches any `isBacktrackableTopologyError` from a candidate attempt (`SHARE_CONSTRAINT_FAILED`, `MISSING_INPUT`, `MISSING_BINDING`, `LINEAGE_UNIQUENESS_CONFLICT`, `MISSING_SERVICE`, … are all in `BACKTRACKABLE_CODES`, `solve-errors.ts`) and, after exhausting candidates, throws `UNSATISFIABLE_TOPOLOGY` with the originals only in `details.failures[]`. Fix direction: when all candidates fail with the same code at a site/path not involving the chosen node, rethrow the underlying error; or resolve Inputs/Bindings/share targets before entering candidate search.
- Scope: `enter()`, `check()`, `explain()`; identical with and without the plan cache (probe 01 confirms the wrapped code is itself cache-neutral). Topology decisions are unaffected — this is a diagnosis defect.

### F-CD-03 — no evidence run matches the shipped source at `e2a6c73`; the release gate (G1) has not been run; root `SHA256SUMS.txt` lists task documents, not artefacts — **major** (delivery credibility / status; not a code defect)

- Trigger: read `validation/v0.5-dev/manifest.json` and `docs/VALIDATION.md` at `e2a6c73`; compute the fingerprint of `e2a6c73` with the orchestrator's own algorithm.
- Expected: §12 — "源码修改后，相关证据必须失效并重跑"; G1 archive/rebuild/pack/consumer evidence, `RELEASE_MANIFEST.json`, `validation/v0.5-release/`, and `SHA256SUMS.txt` "与归档同源"; COMPLETE only when archive rebuild has actually been done.
- Actual: the committed manifest says `status: COMPLETE (mode dev)`, `source.files 172`, `digest 1ef01e47…`, `gitProvenance {commit: 0240b6f…, dirty: true}`. The source at `e2a6c73` fingerprints to `5c63c72d…` (179 files) — 7 files were added and `apps/hyla-mini/package.json`, `packages/core/README.md` (shipped in the tarball), `scripts/verify-v05.mjs`, root `package.json` (scripts, `packageManager npm@10.9.2 → npm@11.12.1`) and `.github/workflows/ci.yml` changed after the recorded run (`git diff --stat 0240b6f e2a6c73`; no `packages/*/src` or `apps/*/src` changes). `validation/v0.5-release/` and `RELEASE_MANIFEST.json` do not exist. `SHA256SUMS.txt` at the root contains hashes of `CLAUDE_CODE_RESEARCH.md`, `START_HERE_ZH.md`, `SYNA_V05_EXECUTION_PROMPT.md`, `SYNA_V05_GOAL.txt` only (inherited from the baseline import) although README and `validation/README.md` describe it as the archive/tarball hash list. `docs/VALIDATION.md` does disclose the dev digest and says the release run "will be refreshed", so this is not concealed — but at this commit the acceptance evidence is stale and G1 is absent.
- Reproduction: `node orchestrator-sim/list-source-files.replica.mjs <repo>` → `{"count":179,"digest":"5c63c72d…"}` vs manifest `172 / 1ef01e47…`.
- Scope: acceptance status at `e2a6c73`. My own G1-style rebuild (§2.1–2.2) passed, so the remedy is procedural: run `node scripts/verify-v05.mjs --release` on the final source and commit the results together (see also F-CD-05, which will otherwise make `dirty: true` unavoidable).

### F-CD-04 — a cached plan template retains ≈200 KiB under a 300-service parent; half of it is two O(graph) strings (the key embeds the parent's whole graph signature, the value stores the child's); default `planCache.maxEntries = 512` therefore admits ≈100 MB of templates — **minor** (P06 deviation; bounded, not a leak)

- Trigger: many distinct Entry shapes planned under one large parent (the shipped `lru-churn` benchmark models exactly this, but with a 1-service world).
- Expected: P06 — "缓存key优先简单稳定结构identity；不要每条template长期持有巨型拼接字符串或短命input。可用hash但须collision处理".
- Actual (`04-template-size.out`, `02-churn.out`): 300-service parent → per request template avg key 45 818 chars, avg stored signature 58 496 chars, 309 graph nodes, ≈199 KiB retained per template; 100-service parent → 16 063 / 19 981 chars, ≈71 KiB. Filling the default cache with 512 shapes under a 300-service Site moved heap after gc from 12.85 MB to 115.59 MB; a further 588 shapes were evicted with only +0.33 MB (LRU bound holds). `planTemplateKey` (`entry-planner.ts` 421–449) rebuilds this key string on every `enter()`; `graphSignature` (51–65) is stored per template and per live plan.
- Scope: memory per template and per live plan in large worlds; realistic apps have few Entry shapes (Hyla-mini's dev run shows 4–8 templates), so exposure is dynamic Entry generation. The `lru-churn-500-shapes` case cannot observe this because its graph is one node.

### F-CD-05 — the test run rewrites the git-tracked `validation/working-set.json`, so `gitProvenance.dirty` is self-inflicted on every clean checkout — **minor** (provenance accuracy)

- Trigger: `apps/hyla-mini/tests/site-manager.test.mjs` line 218–220 writes `path.resolve('validation')/working-set.json` (timestamped `generatedAt`, heap samples) into the source tree; `verify-v05.mjs` computes `gitInfo()` at the end (line 286), after that write.
- Expected: §12 — "Git provenance只写真实信息：真实base commit、dirty状态".
- Actual: in the scratch run the file's `generatedAt` changed `2026-09-05T03:32:27.663Z → 2026-09-05T03:45:15.758Z`; the committed manifest reports `dirty: true`; earlier in this review `git status` showed ` M validation/working-set.json` right after the implementer's run. A checkout with no local changes is reported dirty by its own gate.
- Scope: `gitProvenance.dirty` semantics only. Fix: write the report into `validationDir`, or snapshot `gitInfo()` before running steps.

### F-CD-06 — the orchestrator accepts a failing test marked `todo` — **minor** (process gap, currently unexploited)

- Trigger: any `test(name, { todo: true }, …)` that fails in a must-run step.
- Expected: §12 G0 — pass/fail/skip must be truthful; a must-run step with a failing test is not "ok".
- Actual: node's runner exits 0 and prints `# fail 0 / # todo 1` for a failing todo test (`orchestrator-sim/tap-todo-skip-fixture.tap`: exit 0, `# tests 3 / pass 1 / fail 0 / skipped 1 / todo 1`); `run()`'s `ok` (`verify-v05.mjs` 66) checks `fail` and, with `noSkip`, `skipped`, but never `todo`. `cancelled` is safe because node exits 1 (`# cancelled 1`, exit 1). `grep` finds no `todo`/`skip` options in `packages/core/tests` or `apps/hyla-mini/tests` today.
- Scope: `scripts/verify-v05.mjs` only.

### F-CD-07 — benchmark coverage and reporting gaps against P02/P03 — **minor / limitation**

- `bound-entry-private-range-enter-dispose` times a **one-node** Entry (`PrivateEntry` requires only `Private.range('^1')`; p95 0.020 ms). The 100-service world built in the same function is never entered in the timed loop, so P02's "BoundEntry" and "private range" coverage is trivial (P02: "不要…用空Entry堆深度").
- No benchmark measures the two backend request paths ("两种后端请求（数据库时间单独报告）"); VALIDATION.md acknowledges this ("not claimed here").
- `docs/VALIDATION.md` says v0.5 "is within ~15% of v0.4 on the v0.4 workload"; the committed numbers give +8 %, +11 %, +22 %, +23 %, +28 %, +31 % (four of six cases above 15 %, table in §2.3).
- `benchmarks/results-v0.4.0-baseline-same-machine.json` records no version/commit of the code under test (top-level keys: `generatedAt, environment, methodology, cases`), so "v0.4 code" is asserted by the doc, not by the artefact.
- `budgets.json` path is hard-coded (`v0.5-planning.mjs` 287); an alternative path cannot be passed. I proved the non-zero exit (exit 3) with a sibling copy of the script — see §2.3.

### F-CD-08 — manifests embed absolute host paths; the committed dev manifest ships them inside the git tree — **minor**

- `hyla-demo-filesystem` and `benchmarks` steps record `--root <home>/…` and the absolute benchmark output path in `command` (committed manifest; 2 occurrences in the scratch manifest too). `RELEASE_MANIFEST.json` at the repo root would carry the same. The orchestrator's own release archive excludes `validation/v0.5-dev` and scans for `/Users/…`, so the archive is clean, but `git archive HEAD` (what I was asked to use) does include `validation/v0.5-dev/manifest.json` with those paths, and the archive scan exempts everything under `validation/`.

### F-CD-09 — packed `@syna/core` README points at workspace-only documents — **minor (DX)**

- `packages/core/README.md` (shipped in the tarball) ends with "See the workspace `docs/API_REFERENCE.md`, `docs/SEMANTIC_MODEL.md` and `docs/SEMANTIC_CHANGES_V05.md`" — none are in the tarball and the workspace does not publish to npm, so an installed consumer has no reference beyond the `.d.ts` comments.

### F-CD-10 — `run()` finalizes on the child's `'exit'` event, not `'close'` — **uncertain**

- By inspection (`verify-v05.mjs` 49), stdio may still be draining when `'exit'` fires; a lost trailing TAP summary would silently reduce a step to exit-code-only checking (`noSkip` unenforceable). My replica (`orchestrator-sim/exit-vs-close.mjs`, 8 MiB of output then the summary) captured the summary in 10/10 runs, so I could not reproduce a loss. Listed for completeness; `'close'` is the documented-safe event.

## 4. Verified expectations (run by me; each item names its evidence)

- **R17 cache neutrality.** 278 structural records (slot ownership per node from `env.inspect()`, dependency wiring, `explain()` dispositions/causes/paths, instance identity, error codes) are identical for `planCache {maxEntries: 512}`, `{maxEntries: 1}` (88 evictions) and `{maxEntries: 4}` with five distinct filler Entry shapes before every real `enter` (364 evictions), over three rounds of two Sites × a Layer re-providing an Input × `Req`/`ReqFresh`/`ReqShare` requests, Binding, `auto()`, `C.all` with two versions of one family plus a second family, a Service-owned BoundEntry, `env.bind()`, `check()`/`explain()` (`01-cache-neutrality.out`).
- **R17 realm and parent isolation.** The private-realm template never served a public caller: 18 public attempts (`anchor.enter(PrivateEntry)` and `anchor.bind(PrivateEntry).enter()` under three anchors × three rounds) all `MISSING_SERVICE`, and the owner path returned `true` before and after each attempt. The same `Request` shape under `siteA`/`siteB` reused each Site's own `Cache` slot and instance (`cacheTenant a/b`, `cacheIsSiteCache true`), Pool owned by `app`, request-aware owned by the request. `fresh:[Pool]` forked Pool and its dependants (Cache) but not Logger. Re-providing `Region` with the same payload forked only Panel (`cause dependency-forked via region`), Cache stayed inherited (`01b-r17-details.out`).
- **K12 purity.** 20 `check()` + 20 `explain()` calls left `liveEnvCount` unchanged; no node in a subsequently entered Env had a `check-*` owner.
- **R18 / P04 churn.** 12 000 mixed operations (BoundEntry enter/`tx.load()`/dispose; request enter + `handler.load({ signal })` with one shared `AbortSignal`; deprecated `Capability.selector` open/`implementation.load()`/dispose ×3 000; `C.all` `load(candidate, { signal })` ×3 000) against a 120-service world: `liveEnvCount` 2 throughout, `rootEnvCount` 1, plan cache 7 entries / 7 misses from the first sample to the last (41 995 hits), `internalServices` 129 and `admittedServices` 128 unchanged, `getEventListeners(signal,'abort').length` 0 at every sample, heap after gc 6.89 → 7.12 MB with < 256 KiB drift over the last four samples; `runtime.dispose()` → `liveEnvCount 0`. LRU: 1 100 distinct shapes → entries capped at 512, 590 evictions, +0.33 MB after capacity (`02-churn.out`).
- **R18 source review (by inspection).** Long-lived maps are keyed by definition ids/revision keys (`DefinitionCompiler.*Signatures`, `ImplementationDirectory.byFamily`, `candidateEntryCache` WeakMap by Contract) or by Env id with symmetric delete (`RuntimeImpl.envById`, `roots`, `EnvImpl.children` in `disposeEnv`). Slot ids appear only inside `CandidateRef.sourceSlotId` (collection identity, by design) and plan `slotsByNode`, which die with the Env. `waitWithSignal`/`sleepAbortable` remove their abort listeners on settle (confirmed empirically above). `runtime.dispose()` clears the template cache.
- **R01 / K06 semver.** `Binding.to` defaults: `0.2.0 → ^0.2.0`, `0.0.5 → ^0.0.5`, `2.4.1 → ^2.4.1`, `1.0.0-beta.1 → ^1.0.0-beta.1`. Resolution against admitted sets: `^0.2.0` over `[0.1.9, 0.2.0, 0.2.5, 0.3.0]` → `0.2.5`; over `[0.1.9]` → `MISSING_IMPLEMENTATION` with `available:["0.1.9"]` (no downward relaxation); `^0.0.5` over `[0.0.4, 0.0.5, 0.0.6]` → `0.0.5`; `^2.4.1` over `[2.0.0, 2.4.1, 2.9.0, 3.0.0]` → `2.9.0`; `[2.0.0, 3.0.0]` → `MISSING_IMPLEMENTATION`; prerelease floor honoured (`alpha.1` excluded, `beta.1` chosen); documented M-09 behaviour confirmed (`^1.0.0` picks admitted `1.1.0-rc.1`); unions `1.x || 2.x` and comparator sets resolve to the highest admitted match; exact revision assignment bypasses ranges; unadmitted exact → `MISSING_SERVICE`. Definition-time `TypeError` for `Binding.to(rev, 'definitely-not-a-range')`, `Binding.to(rev, '   ')`, `rev.range('>>1')`, `Binding.parse` with an invalid range or wrong Contract, `Binding.to` on a non-provider, `definePackage({version:'2.4'})`; catalog `persistentRef.version` is `^0.2.5` (`03-semver-binding.out`, 24/24).
- **G1 rebuild.** §2.1: lockfile unchanged by `npm ci`; build/type-tests/core 130/130/fs+render 47/47/PostgreSQL 22/22 all exit 0, no skips, no cancels.
- **Consumer DX.** §2.2: `#syna/package` via `imports` compiles under `@syna/tsconfig/node-app.json`; version auto-injected (`3.2.1`, key `audit.consumer/greeter@3.2.1`); `read()` identity for a Promise payload; deprecated `InputRef.load()` and `Contract.selector` compile (and are `@deprecated` in the shipped `.d.ts`); `loadAll({ inputRef })` and `serviceRef.read()` rejected by `tsc`; `load({ signal })` with a pre-aborted signal → `LOAD_CANCELLED`; `explain()` ok/missing paths work from the tarball.
- **Benchmarks / budgets.** §2.3: environment, sample counts, warmup, per-phase percentiles present; budgets evaluated from `budgets.json`; script exits 3 on a failed budget and treats a missing case/metric as a failure; the orchestrator surfaces that exit code as a failed must-run step (by inspection, `developmentGate` line 157 + `run()` `ok`). P03 target met on this machine: 300-node warm enter+dispose p95 0.301 ms ≤ 2 ms.
- **Orchestrator transparency.** Every step status derives from a spawned process's exit code plus TAP counts (`run()`); the two "internal" steps (`archive-scan`, `consumer-smoke-result`) are computed from scanned files / parsed program output, not written by hand. `noSkip` is set on every test step and any skipped test forces PARTIAL. PostgreSQL unavailable → BLOCKED and exit 3 (§2.4, reproduced); with PostgreSQL reachable but tests failing, TAP counts make it PARTIAL (by inspection). Fingerprint excludes `dist`, `node_modules`, `.tsbuildinfo`, `work`, `coverage` and `validation/v0.5-*` (replicated: identical digest before and after a build; §2.4). No circular hash: `manifest.json`/`RELEASE_MANIFEST.json` are not in `listSourceFiles()`, archive hashes are computed after the archive is written, and the release copy is staged from the working tree — the manifest is a sidecar. `--inside-archive` is parsed but never passed, so release does not recurse into itself. Committed logs match the committed counts (§2.4).

## 5. Remaining risk / not covered

- I did not run `node scripts/verify-v05.mjs --release`; my G1 evidence is my own rebuild (§2.1–2.2), not the orchestrator's release path (`releaseGate`: staging copy, tar/zip, rebuild, pack, consumer smoke). Its consumer smoke exercises fewer APIs than mine and depends on `zip` being installed (not checked).
- `apps/hyla-mini/tests/matrix.test.mjs` was not part of my PostgreSQL step (the task named `postgres.test.mjs` only); it is covered by the committed dev log (25/25 together) and by the scratch orchestrator run only up to the sabotaged step.
- Working-set (P05/H11) behaviour, tenant/permission semantics and Promise/lifecycle semantics belong to the other two audit lines and were not reviewed here beyond what R17/R18 required.
- Template memory (F-CD-04) was measured on synthetic worlds, not on Hyla-mini's actual Entry population.
- F-CD-10 is not reproduced. By inspection only: `run()`'s 20-minute `SIGKILL` kills the direct child (`npm`/`node`), not grandchildren, so a timed-out `pg-test-cluster.mjs with …` step could leave a `postgres` cluster running; not exercised.
- Benchmarks and heap figures were taken while other audit processes may have been active; the budget headroom (≈6×) makes the pass/fail conclusion robust, the absolute numbers less so.
- Everything above is pinned to `e2a6c73`; commits made during or after this review invalidate the fingerprint-related statements in F-CD-03 and require re-running.

## 6. Evidence index (this directory)

`01-cache-neutrality.probe.mjs/.out`, `01b-r17-details.probe.mjs/.out`, `01c-backtracking-wraps-diagnosis.probe.mjs/.out`, `01d-missing-binding-explain.probe.mjs/.out`, `02-churn.probe.mjs/.out`, `03-semver-binding.probe.mjs/.out`, `04-template-size.probe.mjs/.out`, `bench-audit.json` (copy of `/tmp/bench-audit.json`) + `bench-audit.stdout`, `bench-tightened-budgets.{json,result.json,stdout}`, `rebuild-logs/` (per-step logs, `exit-codes.txt`, `rebuild.log` with lockfile hashes), `consumer/` (sources, `<scratch>` substituted for the temp path) + `consumer-logs/`, `orchestrator-sim/` (`manifest.blocked.json`, PostgreSQL step log, TAP fixture output, `exit-vs-close.mjs`, `list-source-files.replica.mjs`) + `orchestrator-sim-blocked.stdout`.

---

_Saved verbatim by the orchestrating session from the auditor's refused `Write` call (the subagent harness returned the report as text instead). No wording was changed._
