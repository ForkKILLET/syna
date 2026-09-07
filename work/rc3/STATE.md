# Syna 1.0.0-rc.3 — working state

Task book `work/tasks/SYNA_RC3_EXECUTION_PROMPT.md` (goal `work/tasks/SYNA_RC3_GOAL.txt`): the closing paths, from an independent audit of 1.0.0-rc.2 — the first round of this project driven by a review rather than by a task the maintainer set. Baseline 1.0.0-rc.2 = commit d7a4410 (gate on 46b344f; `work/rc2/STATE.md`).

## The audit package was not in the workspace

`work/rc3/audit/` — the audit's own probes, which the task book tells this round to run "as they are" — is not present anywhere: not in the working tree, not in the git history, not in the release archives, not under `work/`, `docs/audit/` or `validation/`. The seven probes were therefore reconstructed from the task book's description of each defect and kept in `work/rc3/probes/` (`core-lifecycle.mjs`: L1, L2, L2b, L3; `site-manager.mjs`: A1, A2, A3). Each asserts that the *defect* is present, so on rc.2 the expected reading is REPRODUCED. `work/rc3/BASELINE.md` records this (§0), the seven reproduced on rc.2 (§1), the minimal public-surface increment (§2), the scheduling design of the concurrent destruction (§3), the ten strong-reference paths that kept a closed Env alive (§4) and that no seventh problem was found (§5).

One honest nuance is recorded there and in the probe's own output: A1's queued acquirer does receive `SITE_MANAGER_CLOSED` on rc.2 as well — from the capacity the disposals free, not from the wind-down, which is skipped. The probe's predicate is therefore the sweeper: after an owner abort it was never cleared and kept firing.

## The commits

- 412abdd `chore(tasks)`: the task book and goal under `work/tasks/`, the reconstructed probes and `work/rc3/BASELINE.md`.
- 18b6c7c `fix(core)` **L1**: each Ready slot's cleanup phase gets a `limits.disposalGraceMs` of its own; what outlives it is abandoned (slot `abandoned`, ledger entry under the attempt that produced the instance, `attempt-abandoned` with the new `phase: 'cleanup'` and the dependency list), the rest of the slots are disposed regardless, independent components of the SCC condensation are destroyed concurrently while every chain keeps its dependant-first order, `dispose()` does not reject for an abandoned cleanup, a late end leaves the ledger and a late failure is `attempt-failed-late`, and `runtime.dispose()` gives abandoned cleanups the same grace before `runtime-attempts-outstanding`.
- 212e58f `fix(core)` **L2**: every cleanup failure the close waited for enters the `AggregateError` of `dispose()` exactly once, whatever became of the waiter; the late events are emitted from the start of the close, not only after it ended. Implemented with `SetupAttempt.reportsToClose` and `AttemptOwnerRecord.closeErrors`, which also covers the window between `broadcastClosing` and `settleSlots`.
- f75e7d4 `fix(core)` **L3**: a listed attempt holds its slot only weakly and its owner as a minimal record (`AttemptOwnerRecord`: env id, close flag, the close's cleanup errors) — deliberately *not* the `AbortSignal`, whose abort reason retains the receiver of every frame of its stack; the late-settlement reactions and the lifecycle handed to `setup()` are built in scopes of their own.
- 780dcea `fix(app)` **A1, A2, A3**: `admissionClosed` and one idempotent `shutdownPromise` are two things; `acquireTimeoutMs` covers the configuration read (per-caller deadline on the shared single-flight round trip, which is not cancelled); `shutdown()` ends every in-flight caller's wait with `SITE_MANAGER_CLOSED` without waiting for the store; `stats()` gains `inFlightConfigReads` and `inFlightAcquires`.
- cb02425 `docs(close)`: `docs/SEMANTIC_MODEL.md` §11 and §13, `docs/SEMANTIC_CHANGES_RC3.md`, `docs/API_REFERENCE.md` (the D1 comment and the close/event/lifecycle notes), `docs/MULTITENANT_BLOG.md`, `docs/API_STABILITY.md` (the registered exception), `docs/HISTORY.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`; the gate's `blog-close-path-tests` step and the inventory's registered-increment assertion.
- 072fd23 `build(gate)`: `benchmarks/results-v1.0.0-rc.2-baseline-same-machine.json` and the baselines pointed at 1.0.0-rc.2 / `d7a4410`.
- ceebfc4 `chore(release)`: version 1.0.0-rc.3 everywhere, lockfile regenerated with no further change.
- fc4bb7d `chore(probes)`: two probe detail lines that only read correctly while the defect was present.
- 31f54ac `perf(core)`: a slot that registered no cleanup arms no grace timer (the one regression the first gate run found); the `limits.disposalGraceMs` entry of `docs/API_REFERENCE.md` brought in line with §13.
- 5ae7baf `build(gate)`: the two rows this round is measurably faster on, registered with their reason and a floor.
- The release commit (the commit that carries this ledger): the gate evidence, `docs/VALIDATION.md` generated from it, and this file.

## The seven probes, flipped

Each probe was written to assert that the defect is present; on `d7a4410` all seven print REPRODUCED (`work/rc3/BASELINE.md` §1). On 5ae7baf, run from the same files:

```
$ node --expose-gc work/rc3/probes/core-lifecycle.mjs
PROBE L1 NOT-REPRODUCED — a hung Ready-slot cleanup is not bounded by the disposal grace
    grace 50 ms; dispose() fulfilled after 53 ms; env.state=disposed
PROBE L2 NOT-REPRODUCED — a rollback cleanup that throws inside the close window is not reported by dispose()
    dispose() rejected; events=[attempt-succeeded-late]; the waiter's own rejection was an AggregateError: true
PROBE L2b NOT-REPRODUCED — with the waiter gone the same cleanup failure is visible nowhere
    waiter=LOAD_CANCELLED; dispose() rejected; events=[attempt-succeeded-late]
PROBE L3 NOT-REPRODUCED — the ledger retains the closed Env graph through attempt.slot.ownerEnv
    ledger=1; closed Env reachable: false; its Input payload reachable: false; control Env reachable: false
core probes: 0/4 reproduced

$ node work/rc3/probes/site-manager.mjs
PROBE A1 NOT-REPRODUCED — after an owner abort, shutdown() skips clearInterval (the sweeper survives the close)
    intervals created=1, cleared=1; the sweeper fired 1 times before the close and has not fired since (1 → 1); the queued acquirer settled with {"value":"SITE_MANAGER_CLOSED"}
PROBE A2 NOT-REPRODUCED — acquireTimeoutMs does not cover the configuration read
    acquireTimeoutMs=200 ms; after 202 ms acquire() is settled with {"value":"SITE_CAPACITY"}
PROBE A3 NOT-REPRODUCED — shutdown() leaves in-flight callers waiting on the store
    shutdown() returned after 0 ms; the in-flight acquirer is settled with {"value":"SITE_MANAGER_CLOSED"}
application probes: 0/3 reproduced
```

The same seven behaviours are asserted as tests, in their correct-behaviour form: `packages/core/tests/rc3-close-paths.test.mjs` (5 cases) and `apps/multitenant-blog/tests/rc3-close-paths.test.mjs` (3 cases), both run by the gate (`core-tests`, `blog-close-path-tests`, and again in the rebuilt copy).

The 4×4 close matrix is `packages/core/tests/close-matrix.test.mjs`, 18 cases, all green:

```
close matrix: {ready-hangs, ready-throws, rollback-throws, late-cleanup-throws} × waiter {none, waiting, cancelled, timeout}   16/16
concurrent destruction: three independent chains are disposed at once while each chain keeps its own order
the cleanup step of one Env costs one grace per slot of its longest chain, not one per slot
```


## The release gate on 5ae7baf — COMPLETE

`node scripts/verify-release.mjs --release` alone, nothing else running (log in the session scratchpad; the step logs stay untracked):

- `COMPLETE`, started 2026-09-07T19:37:31.214Z, generated 2026-09-07T19:41:41.863Z, 53 steps ok of 53, 966 test executions (483 distinct cases, 483 re-executed in the rebuilt copy), 966 passed, 0 failed steps, 0 skipped; source fingerprint `b8f89b731f356ffeb533e31a7ac93129db5f7eadb31986e5eed8d96530033e86` (372 files); provenance commit 5ae7baf5276ae936234b57e88d40addaa4d8b60c, `dirty: false`, `modified: []`, `untracked: []`; PostgreSQL 17.10 on a temporary cluster at 54329.
- `api-inventory-no-deprecated`: 374 items, 0 `@deprecated`. `api-inventory-unchanged` against the 1.0.0-rc.2 record (commit 46b344f) and `api-inventory-frozen` against the 0.8.0 record (commit 38a722e): 374 = 374, **0 added, 0 removed, 3 changed — exactly the registered increment** (`RuntimeEvent`'s signature; the JSDoc of `RuntimeLimits.disposalGraceMs` and of `UnsettledAttemptInspection.state`). The doc-aware diff separates them: 1 changed signature, 2 doc-only.
- Suites: `type-tests` ok, `core-tests` 266/266, `blog-filesystem-tests` 69/69, `blog-render-tests` 8/8, `blog-tenants-auth-preflight-tests` 12/12, `blog-audit-regression-tests` 22/22, `blog-review-regression-tests` 8/8, **`blog-close-path-tests` 3/3**, `blog-site-manager-working-set-tests` 14/14, `blog-postgres-and-matrix-tests` 45/45 (real PostgreSQL), `gate-self-tests` 36/36; in the rebuilt copy `rebuild-core-tests` 266/266, `rebuild-app-tests` 136/136, `rebuild-postgres-matrix-tests` 45/45, `rebuild-gate-self-tests` 36/36.
- `no-old-reference-tokens`: 58 files scanned, 0 hits. `no-vendor-names`: 232 files scanned, 0 hits, 12 allowed literals of the application. `any-count` OK against `scripts/any-baseline-v1.0.0-rc.2.json`: 178 in 83 files against a baseline of 178 in 66 files — not increased, and the files outside the baseline use none. `codemod-idempotent` / `rebuild-codemod-idempotent`: 0 edits.
- The seven examples and the reference application's demo: `demo-01-basics` … `demo-07-failure-modes`, `blog-demo-filesystem`, and in the rebuilt copy `rebuild-examples` and `rebuild-demo` — all ok with their stable lines.
- `benchmark-compare` (same session against `d7a4410`, both sides under `--expose-gc --no-maglev`, 21 rounds, element-wise median): **116/116 equality rows equal, 23/23 tolerance rows within ±10 %**, two of them registered improvements (`warm-enter-dispose-300-depth-6.timing.p95Ms` −13.5 %, `site-enter-tenant-input-reverse-closure-200.timing.p95Ms` −17.6 %; §7 of the semantic record). **No dispose-related row regressed**: `phase-breakdown-300.disposeMs` p50 +1.4 %, p95 +3.6 %; `materializationMs` p50 +1.4 %, p95 +5.5 %; `churn-10000-requests.perOperationMs` +0.6 %. Record drift (informational, this session's 1.0.0-rc.2 side against the recorded file): 116/116 equal, 18/23 within ±10 % — the sub-0.1 ms `phase-breakdown-300` rows, the machine hours later on the same source, not the code.
- Working set (H11): 6 site Envs alive of capacity 6 (2 base Envs, peak sample 8), 481 creations, 480 evictions, 0 rejected for capacity, `inFlightConfigReads` and `inFlightAcquires` both 0 at the end.
- Archives (`validation/v1.0.0-rc.3-release/SHA256SUMS.txt`):
  - `work/release/syna-v1.0.0-rc.3-source.tar.gz` 869559 bytes sha256 `d80badf4c4efd0a6988fd1efab758e71e90b7c97a183522b766ee6da59532b64`
  - `work/release/syna-v1.0.0-rc.3-source.zip` 1089260 bytes sha256 `fed1512d4c13d6aacf16bcbf7cfc39cb4aa0b2b70deb16cc56b2d8c74322cce5`
  - `work/release/pack/syna-core-1.0.0-rc.3.tgz` 117968 bytes sha256 `fd9d3792fa95b6a9b069fbe420cc0fb78c0d9f54f2ad7aaad051d1ded54f0a33`
  - `work/release/pack/syna-tsconfig-1.0.0-rc.3.tgz` 1573 bytes sha256 `71b91f0a47edabfbc93d5293b845b3f7dceda78ea70d63ef98bd6907f4465f2a`
- Consumer smoke (the packed tarballs installed into a fresh project, compiled and run): `{"result":84,"revision":"7.3.1","explainOk":true,"missing":"smoke.consumer/input/answer/v1","abandoned":0,"revisions":"7.3.1","slots":"ready,ready"}`.
- `docs/VALIDATION.md` generated from this manifest by `node scripts/validation-doc.mjs`; `RELEASE_MANIFEST.json` is this manifest.

### The first run, and what it found

An earlier `--release` run on fc4bb7d was `PARTIAL`: 52 steps ok, `benchmark-compare` FAILED with 19/23 — `phase-breakdown-300.disposeMs` p50 +15.9 % and p95 +20.7 %, exactly the regression the task book forbids. Cause: the bounded cleanup armed a `settlesWithin` timer for every Ready slot, and no service in that benchmark registers a cleanup at all — 300 timers for nothing. Fixed in 31f54ac (a slot with an empty cleanup list has nothing that can outlive the budget, so no timer is armed); its outputs were discarded and the run above is the one that stands. The other two rows outside ±10 % in that run were improvements, investigated and registered in 5ae7baf.


## Acceptance (§5 of the task book)

- **A01** — the four planning modules unchanged: `git diff d7a4410..HEAD -- packages/core/src/internal/entry-planner.ts packages/core/src/internal/graph-builder.ts packages/core/src/internal/definition-compiler.ts packages/core/src/internal/plan-cache.ts` is empty. The reference-planner differential and the explain/inspect snapshots are verbatim: `reference-planner.test.mjs` and `v06-snapshots.test.mjs` inside `core-tests` (266/266) and `rebuild-core-tests`, unchanged since 0.8.0.
- **A02** — inventory diff exactly the §2.0 increment (0 added, 0 removed, 3 changed): `api-inventory-unchanged`, `api-inventory-frozen`, `api-inventory-diff`, and `scripts/tests/api-inventory.test.mjs` inside `gate-self-tests`. Registered in `docs/API_STABILITY.md` ("Registered exception — 1.0.0-rc.3").
- **A03** — L1: `RC2-L1 a hung Ready-slot cleanup is abandoned by the bounded close…` asserts `dispose()` fulfils in one budget (+ tolerance), `env.state === 'disposed'`, the ledger entry, `attempt-abandoned` with `phase: 'cleanup'`, the dependants-first order of the abandoned slot's dependencies (`['hung-started','middle','deep']`), the slot `'abandoned'` then `'disposed'`, and the ledger entry gone after the late end. The upper bound is `close-matrix.test.mjs` "one grace per slot of its longest chain, not one per slot".
- **A04** — L2: all 16 matrix cells pass; `RC2-L2` asserts the failure is in the `AggregateError` of `dispose()` exactly once; `RC2-L2b` runs the same case with the waiter cancelled and with the waiter timed out and asserts the same reporting and the same events.
- **A05** — L3: `RC2-L3` runs in a child process under `--expose-gc`, holds `WeakRef`s to the closed Env, to its Input payload and to an unrelated control Env, and asserts after collection that the closed Env and its payload are unreachable while the attempt is still pending, that the control is unreachable too, and that the ledger holds exactly 1 entry — then releases the attempt and asserts its cleanup still ran. The ten strong-reference paths are listed in `work/rc3/BASELINE.md` §4, each with the change that closed it; row 10 (the `AbortSignal`'s abort reason retaining every stack frame's receiver) was found with a heap snapshot and is why `AttemptOwnerRecord` deliberately has no signal.
- **A06** — A1: `RC2-A1 the site manager winds down exactly once on all three closing paths` covers explicit `shutdown()`, owner abort and startup rollback: the sweep interval is cleared on each, no waiter is left hanging, and the second call gets the same report from the same `shutdownPromise`.
- **A07** — A2/A3: `RC2-A2` blocks the configuration read and asserts the refusal inside `acquireTimeoutMs`; `RC2-A3` asserts `shutdown()` ends an in-flight caller's wait with `SITE_MANAGER_CLOSED` without waiting for the store; `stats()` carries `inFlightConfigReads` and `inFlightAcquires` (both in the working-set record above).
- **A08** — D1: the 0.6 comment at `docs/API_REFERENCE.md:162–163` is gone; the `limits.disposalGraceMs` entry, the `attempt-abandoned` entry, "Ready and closing", the lifecycle note, §11 and §13 of `docs/SEMANTIC_MODEL.md`, the `descriptors.ts` comments and `apps/07-failure-modes` all read `disposed` the same way: the end of the bounded close, whatever it stopped waiting for.
- **A09** — `docs/SEMANTIC_CHANGES_RC3.md`: §1 retained, §2 the D1 clarification, §3 the two revisions, §4 the L3 implementation correction, §5 the increment and its registration, §6 the withdrawn/rewritten test list (none: three new files, no assertion changed), §7 the one performance regression that was fixed and the two improvements that were registered.
- **A10** — benchmark 23/23 within ±10 % with no dispose regression, `any` not increased (178 = 178), the gate rebuilt from the final archive (`rebuild-*`, `pack-*`, `consumer-*`) printing `COMPLETE` with provenance `dirty: false`.

Not done, deliberately: no tag, no push, no publish; nothing recorded in `docs/DEFERRED.md` (no problem outside the matrix was found and left); no refactor — `materializer.ts` is not split, no test directory was reordered, no gate script was merged (all rc.4).

## Reproduce

- Probes: `node --expose-gc work/rc3/probes/core-lifecycle.mjs` and `node work/rc3/probes/site-manager.mjs` (both print `0/N reproduced` on this tree; on `d7a4410` they print `4/4` and `3/3`). Afterwards `rm -rf apps/multitenant-blog/work`.
- Suites: `npm run typecheck && npm test && npm run test:scripts && npm run test:app && npm run test:postgres && npm run demo && npm run demo:multitenant-blog` (then `git checkout -- work/v05/working-set.json; rm -rf work/demo-content`).
- The close matrix alone: `node --test packages/core/tests/close-matrix.test.mjs`; the flipped probes as tests: `node --test packages/core/tests/rc3-close-paths.test.mjs apps/multitenant-blog/tests/rc3-close-paths.test.mjs`.
- Gate: `node scripts/verify-release.mjs --release` alone (about seven minutes; PostgreSQL 17 binaries or `SYNA_TEST_PG_URL`; the git history with `d7a4410` for the same-session comparison, else the recorded file on this machine). Then `node scripts/validation-doc.mjs` and commit `RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.3-release/` and `docs/VALIDATION.md` together; the step logs stay untracked (`*.log`).
- The benchmark by hand, fewer rounds: `node scripts/benchmark-same-session.mjs --commit d7a4410 --baseline-label 1.0.0-rc.2 --runs 7 --out-dir <dir> --faster-ok cases.warm-enter-dispose-300-depth-6.timing.p95Ms,cases.site-enter-tenant-input-reverse-closure-200.timing.p95Ms --faster-floor 0.30`.
