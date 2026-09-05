# Issues (counterexamples, expectation, repro, root cause, fix, re-verify, status)

Format: `### I-nn — title` then fields.

### I-01 — Input payload Promise is assimilated by `load()`
- Probe: work/v05/probes/v04-probes.mjs "R05 Input payload Promise identity preserved" → FAIL on v0.4 (`got "inner"`).
- Expected: `InputRef.read()` returns the very payload object (Promise, thenable, function, undefined).
- Root cause: `Materializer.resolveSlot` is `async` and returns the payload → await assimilates thenables.
- Fix: K05/D07 — sync `read()`, deprecated `load()` returns `Awaited<T>`. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-02 — Un-awaited `load()` inside setup adds a completion barrier to the caller
- Probe: "K07 un-awaited load() does not add a barrier" → FAIL (timeout 200ms).
- Root cause: `trackStrongOperation` + `drainStrongLoads` (ALS frame).
- Fix: D04/D05 remove barrier. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-03 — `catch` around a failing lazy backend cannot produce a degraded Ready consumer
- Probe: "R02 setup catch of lazy failing backend" → FAIL (`backend down` propagates).
- Root cause: same barrier — the tracked strong load rejects the caller after its own setup returned.
- Fix: D04. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-04 — `Promise.race` fallback is blocked by the slow dependency
- Probe: "R04 Promise.race fallback" → FAIL (timeout 300ms). Fix: D04. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-05 — BoundEntry invoked during owner activation returns a Ready child (fake Ready)
- Probe: "K02/H13 BoundEntry during owner activation" → FAIL (`child entered while owner activating (state=ready)`).
- Root cause: activation transactions (`allowActivatingAnchor`, wait edges) publish a child whose anchor is not Ready.
- Fix: D08 — reject with OWNER_NOT_READY. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-06 — Service-owned private Entry: exact root resolves, range root fails (MISSING_SERVICE)
- Probe: "R07 private range" → FAIL (`exact=tx range=ERR MISSING_SERVICE`).
- Root cause: `GraphBuilder` range case filters `admittedRevisions` only; realm ignored.
- Fix: D09 realm closure. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-07 — Hand-written semver rejects union ranges and misorders comparator sets
- Probe: "K06 semver" → FAIL (`1.x || 2.x` throws; `>=1.2.0 <2.0.0 || >=3.0.0` wrong).
- Fix: D03 — npm `semver`. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-08 — Rollback failure does not stop the retry sequence
- Observed by reading `runSetupSequence`: `mayRetry` ignores `cleanupErrors`. Expected (K08): a failed rollback ends the sequence.
- Fix: in Attempt sequencing. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-09 — Immediate CIRCULAR_MATERIALIZATION on a load-call cycle (over-eager)
- v0.4 probe passes only because the cycle is real; legal pre-fetch/race patterns are misreported (I-02/I-04 show why).
- Fix: D06 deadline diagnostics. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests in packages/core/tests/v05-*.test.mjs).

### I-10 — Sequence promise unobservable during synchronous setup re-entry
- Found by: v04 probe "true pending wait cycle" on v0.5 → `Cannot read properties of undefined (reading 'then')`.
- Root cause: `slot.sequence` was assigned after `runSequence()` had already run setup synchronously; a dependency's setup calling back `load()` on the starting slot saw no sequence.
- Fix: deferred sequence promise created before setup runs (materializer.ts `startSequence`). Regression: lifecycle.test.mjs setup-cycle test, v05-promises R04. Status: FIXED.

### I-11 — `opaque()` could not deliver a thenable instance (assimilated by every await)
- Found by: v05-promises test timed out at 30 s.
- Resolution: removed `opaque()`; instances can never be thenable through `await`; foreign thenables returned synchronously are diagnosed (`foreign-thenable-setup`). Documented in MIGRATION M-15. Status: RESOLVED (design).

### I-12 — Activation failures propagated inner SynaError codes inconsistently
- Found by: migrated tests expecting `ENTRY_ACTIVATION_FAILED` with `cause`.
- Fix: enterFrom always wraps activation failures with `cause` and `details.causeCode`. MIGRATION M-13. Status: FIXED.

### I-13 — Range roots only see revisions the Runtime knows
- Found by: benchmark private-range case (`MISSING_SERVICE` for a family referenced only through `Family.range()`).
- Resolution: by design — a range selects among admitted ∪ owner-closure revisions; a revision referenced only through a range is unknown. Documented (SEMANTIC_CHANGES §7); benchmark fixture declares the exact dependency. Status: DOCUMENTED.

### I-14 — SiteEnvironmentManager: waiter starvation and stale-revision acquire
- Found by: site-manager.test.mjs H10/H11 first runs (waiter timed out although an env was released; "Site environment … is draining" thrown to a request that read an older config).
- Fix: capacity reservations granted to the longest waiter on free; idle env released while acquirers wait is evicted for them; acquire re-reads configuration when it lands on a draining record. Regression: site-manager.test.mjs. Status: FIXED.

### I-15 — Lazy authenticator hid site configuration errors until first request
- Found by: H10 cold-creation test (expected creation failure did not happen).
- Fix: manager loads the site authenticator at creation. Status: FIXED.

### I-16 — fetch() cannot send a custom Host header
- Found by: H08 tests (404 Unknown host 127.0.0.1). Fix: test harness uses node:http. Status: FIXED (tests only).

## Findings of the independent audits (2026-09-05)

Source: `work/v05/audit/*/REPORT.md` (archived in `docs/audit/`). Status after fixes; regression tests named per item.

### Promise / lifecycle line (`packages/core/tests/v05-audit-lifecycle.test.mjs`)
- I-17 (F-PL-01, major) `dispose()`/`run()`/failed `enter()` waited for the full initialization deadline of running attempts; `setupDeadlineMs: Infinity` hung disposal forever. Fix: `settleSlots` gives every in-flight attempt (running or timed out) at most `disposal.graceMs`, per slot concurrently; running attempts are abandoned through `attempt.abandon()` (a third arm of the deadline race) and their late result is still discarded, cleaned and reported. Status: FIXED.
- I-18 (F-PL-02, major) `onDispose()` after the deadline threw `INVALID_ENV_STATE`; the late-acquired resource leaked and the failure was blamed on the setup. Fix: accepted while the raw setup Promise is pending (any attempt state); refused once settled. Status: FIXED.
- I-19 (F-PL-03, major) Ancestor disposal aborted only its own signal and closed children one by one; later siblings accepted new work during shutdown. Fix: `broadcastClosing()` marks the whole subtree `disposing` and aborts every signal synchronously; children (and roots in `runtime.dispose()`) close concurrently. Status: FIXED.
- I-20 (F-PL-04, minor) `env.state === 'disposed'` and the Env left `inspect()` while an abandoned attempt still ran; a later `runtime.dispose()` fulfilled silently. Fix: the Env stays `disposing` and registered until every abandoned attempt settled and every descendant finalized; `runtime.dispose()` re-reports. Existing K08 test updated (documented as M-18). Status: FIXED.
- I-21 (F-PL-05, minor) Dependency adjacency stopped at a non-Ready Service slot, losing A→(dormant B)→C ordering. Fix: traversal continues through slots outside the disposable set. Status: FIXED.
- I-22 (F-PL-06, minor) A forgotten `load()` was an unhandled rejection only on the failed-slot path. Fix: every caller gets its own Promise (`value.then(x => x)`); the shared sequence keeps its internal handler. Documented as M-19. Status: FIXED.
- I-23 (F-PL-07, minor) `load({ signal })` with a pre-aborted signal started the dormant slot. Fix: checked before `serviceValue()`. Status: FIXED.
- I-24 (F-PL-08, design question) A disposed child handle can still start parent-owned dormant slots. Decision D22: refs are slot-bound; validity follows the owner Env. Status: DOCUMENTED (API_REFERENCE lifecycle notes).

### Cache / delivery / DX line (`packages/core/tests/v05-audit-planning.test.mjs`, orchestrator)
- I-25 (F-CD-01, major) `explain()` reported empty `missingInputs`/`missingBindings` for parameters required deep in the graph. Fix: `collectMissingParameters` reads `details.missing` of deep `MISSING_INPUT`/`MISSING_BINDING` and recurses into `details.failures`. Status: FIXED.
- I-26 (F-CD-02, major) Candidate backtracking wrapped candidate-independent failures into `UNSATISFIABLE_TOPOLOGY`; the code depended on `requires` key order. Fix: when every candidate fails identically (code+message+details) the failure is rethrown under its own code (D27). Status: FIXED.
- I-27 (F-CD-03, major, delivery) No evidence run matched the shipped source; G1 never run; root `SHA256SUMS.txt` is the task-document list. Fix: release gate run on the final source (see docs/VALIDATION.md); release hashes written to `validation/v0.5-release/SHA256SUMS.txt`, root file untouched (D23). Status: RESOLVED BY RELEASE RUN.
- I-28 (F-CD-04, minor) Plan-template keys embedded the parent's whole graph signature (~45 KB under 300 services). Fix: key carries a compact digest, the template stores the parent signature and verifies it on hit (a collision can only cost a miss). The template's own signature (needed as the grandchildren's parent signature) is retained; per-template memory is dominated by the graph itself and bounded by `planCache.maxEntries`. Status: MITIGATED.
- I-29 (F-CD-05, minor) Tests rewrote tracked `validation/working-set.json`; provenance looked dirty. Fix: report path from `SYNA_WORKING_SET_OUT` (gate: run directory; default `work/v05/`); tracked copy removed; `gitInfo()` captured before any step. Status: FIXED.
- I-30 (F-CD-06, minor) A failing `todo` test passed the gate. Fix: `todo` and `cancelled` count as not run; `cancelled > 0` fails. Status: FIXED.
- I-31 (F-CD-07, minor) The BoundEntry benchmark timed a one-node graph; VALIDATION.md understated the v0.4 delta. Fix: `bound-entry-private-range-request-enter-dispose-100` plans a request chain (≈100 inherited / 20 new) under a budget; VALIDATION.md reports the per-case percentages. Backend request timing remains uncovered (documented). Status: FIXED / LIMITATION.
- I-32 (F-CD-08, minor) Manifests embedded absolute host paths. Fix: `<root>` substitution for commands and env. Status: FIXED.
- I-33 (F-CD-09, minor) Packed core README pointed at unshipped docs. Fix: README states where the docs live. Status: FIXED.
- I-34 (F-CD-10, uncertain) `run()` finalized on `exit`. Fix: `close` event; SIGTERM before SIGKILL on timeout. Status: FIXED.

### Application / permissions / resources line (`apps/hyla-mini/tests/audit-app.test.mjs`, conformance suite)
- I-35 (F-AP-01, major) SiteEnv rotated to draining while creating was never disposed. Fix: `settle()` after creation/join; sweep disposes idle draining records. Status: FIXED.
- I-36 (F-AP-02, major) `invalidate()` made the tenant unacquirable while a lease was held. Fix: per-tenant generation in the key. Status: FIXED.
- I-37 (F-AP-03, major) URL parsing exceptions escaped both HTTP handlers (hung connections; process death under default policy). Fix: 400 for unparsable targets; `guarded()` wrapper; static server refuses dot-files. Status: FIXED.
- I-38 (F-AP-04, major) Page cache never invalidated by content changes. Fix: store `contentVersion()` (PG table / FS file, advanced by every mutation) in the cache key; cache dropped when it moves. Status: FIXED.
- I-39 (F-AP-05, minor) Fast-failing creation not single-flight. Fix: backoff re-checked after the store round-trip; `SiteCreationBackoffError` with `cause`. Status: FIXED.
- I-40 (F-AP-06, minor) Internal diagnostics echoed to clients. Fix: generic bodies with codes; `onError` hook. Status: FIXED.
- I-41 (F-AP-07, minor) `pool.end()` twice on failed setup. Fix: `onDispose` registered after the probe. Status: FIXED.
- I-42 (F-AP-08, minor) Static builder deleted files it never wrote. Fix: `.hyla-build.json` manifest; only listed files removed; foreign non-empty directories refused. Status: FIXED.
- I-43 (F-AP-09, minor) `stop()` during `start()` lost. Fix: `starting` state; stop wins. Status: FIXED.
- I-44 (F-AP-10, limitation) Interface-incompatible authenticator override failed on first request. Fix: shape check at site creation. The core cannot check TypeScript interfaces at runtime (K11 limitation documented). Status: FIXED (app) / DOCUMENTED (core).
- I-45 (F-AP-11, minor) `createHylaApp()` resolved with an unreachable database; runtime not disposed on `AppEntry` failure. Fix: store loaded at startup inside try/catch that disposes the runtime. Status: FIXED.
- I-46 (F-AP-12, minor) `close()` discarded the unreleased-lease report. Fix: `close()` returns `HylaShutdownReport`. Status: FIXED.
- I-47 (F-AP-13, limitation) A tenant claiming another tenant's domain stopped the whole domain table. Fix: stores refuse the save (`DomainConflictError`); table serves a conflicted host to nobody and lists `conflicts`. Status: FIXED.
- I-48 (found while re-running the auditor's storm probe after I-35) Acquire gave up after 5 immediate retries under a burst of configuration saves. Fix: retries bounded by `acquireTimeoutMs` (`SITE_CAPACITY` afterwards). Status: FIXED.

### Auditor probes whose FAIL lines now reflect intended behaviour (re-run 2026-09-05 against the fixed build)
- promise-lifecycle `01` (unhandled rejections now consistent), `04` (pre-aborted signal starts nothing), `06` (`rootEnvCount`/`liveEnvCount` stay 1 while an abandoned attempt is outstanding — the honest state of I-20).
- app-permissions `site-manager-race E` (later acquirers get `SITE_CREATION_BACKOFF` instead of the original error), `static-export` (`.hyla-build.json` present in the output directory), `tenant-isolation` (the probe's own setup saves beta with alpha's domain, which the store now refuses; 72 checks passed before that point).
