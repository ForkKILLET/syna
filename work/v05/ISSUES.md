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
- I-49 (found by the release gate, run 2 of 2026-09-05) `site-manager.test.mjs` H10 backpressure case failed 1 in ~40 runs: two acquirers were issued concurrently and the test assumed the first-issued one is queued first, but an acquirer joins the capacity queue only after its configuration read, and two concurrent filesystem reads may complete in either order. Manager behaviour (FIFO by queue arrival) is correct; the test now waits until the first acquirer is queued before issuing the second and reports the actual error when the waiter fails. Status: FIXED (test).

## Findings of the second review round (2026-09-05)

Four items reported by different reviewers after the audit fixes (the user's goal message of 2026-09-05). Each reproduced with a probe against the fixed build (probes archived under `work/v05/probes/review-2026-09-05/`, import paths made workspace-relative); regression tests `packages/core/tests/v05-review-lifecycle.test.mjs` (R-1…R-4, 6 tests) and `apps/hyla-mini/tests/review-app.test.mjs` (R-2…R-4, 6 tests).

### Core lifecycle line (`v05-review-lifecycle.test.mjs`)
- I-50 (item 1 + item 4a, major) A failed rollback did not end the slot: under `afterExhaustion: 'retry-on-next-load'` the next `load()` after the cooldown started a new attempt and its resources stacked on the ones the failed `onDispose` left behind (probe: a Pool service whose cleanup throws; second load opened a second pool). K08 forbids retrying past a failed rollback. Fix: `ServiceSlot.rollbackFailed` (permanent) set by `runSequence` on cleanup errors and by `closeUnsettled` when a late cleanup fails; `serviceValue` and `recoverFailedSlot` (also after the cooldown) reject with `ROLLBACK_FAILED` carrying the original error as `cause`. Clean rollbacks still recover (controls in both tests). Status: FIXED (D32, M-20).
- I-51 (item 1 + item 4b, major) A caught `LOAD_CANCELLED` could still produce an unhandled rejection: `waitWithSignal` returned the `LOAD_CANCELLED` rejection while the waiter's shared setup Promise, now unobserved, rejected later. Fix: the aborted branch attaches a no-op rejection handler to the shared Promise before rejecting the caller. Verified for 14 cancellation paths (dormant/starting/timed-out/abandoned attempts, closing owners, `run()`/`enter()`, pre-aborted signals) in a `--unhandled-rejections=strict` child process. Status: FIXED.
- I-56 (item 3, major) An Env whose close abandoned an attempt stayed in `parent.children`, `roots` and `envById` for as long as the attempt ran, with its whole graph retained: with a setup that never settles (or one kept alive by user code) the bounded close of I-17/I-20 had become unbounded retention. Fix: `disposeEnv` detaches the Env at the end of the bounded close (`detachEnv`) whether or not attempts are outstanding; `finalizeEnv` only flips the state once everything that close abandoned has settled. Abandoned and timed-out attempts are recorded in a weak ledger (`Materializer.unsettled`, `WeakRef` to the attempt; `inspect().unsettledAttempts` prunes dead entries) and a `FinalizationRegistry` on the raw setup Promise closes an attempt nobody can settle any more (`attemptUnreachable` → `closeUnsettled`: cleanups run, slot `disposed`, `attempt-unreachable` event). `runtime.dispose()` reports a non-empty ledger (`UNSETTLED_ATTEMPT` with `details.attempts`); Hyla `close()` returns it. A parent no longer waits for a child that finished its own bounded close earlier (that child reported its attempts to its own disposer); a child closed by the parent's call still holds the parent in `disposing` until it finalizes. Two measurement artefacts met on the way, both in the probes/tests rather than in the Runtime: `WeakRef.deref()` keeps its target alive until the end of the current job (so a loop that derefs and then calls `gc()` never sees the collection), and a suspended top-level frame keeps the register of a finished loop's last iteration alive (1/50 "retained" until the loop moved into its own function). Status: FIXED (D31, M-18, M-21); F-PL-04 tests rewritten for the ledger (`liveEnvCount` 0, `unsettledAttempts` 1).
- I-57 (item 4c, inherent) The dependencies of an abandoned attempt are disposed after the grace while the attempt may still run. Analysis in docs/AUDIT.md: waiting is unbounded, killing is excluded by §14 (and impossible for a Promise chain), keeping the dependencies alive is I-56 one level up; so the behaviour stays and is acknowledged: `UNSETTLED_ATTEMPT.details.slots[].dependencies` lists each service dependency with its slot, revision and state. Status: DOCUMENTED (D34), regression R-4 asserts the order and the report.

### Application line (`review-app.test.mjs`)
- I-52 (item 2, major) `SiteEnvironmentManager.create()` entered the SiteEnv, then validated the authenticator shape / checked for shutdown; a failure there returned without disposing the Env (leak, and `liveEnvCount` grew per failed acquire). Fix: `record.env` is assigned right after `enter()`; on failure the record's disposal (or a direct dispose) runs before the error propagates; a manager that closed meanwhile fails with `SiteManagerClosedError` and no backoff. Status: FIXED.
- I-53 (item 2, major) `evictIdle()` deleted the record and granted the waiter before `env.dispose()` settled, so `capacity` was a limit on records, not on live Envs. Fix: records move to `disposing` (`disposeRecord`) and keep their unit until the close settles; `stats().disposing` counts them; the waiter is granted in `finally`, FIFO. `sweep()` closes concurrently. Status: FIXED (D33).
- I-54 (item 2, major) `SiteContext` read the store content first and `contentVersion()` afterwards; an edit between the two reads was cached under the new version and served stale until the next mutation. Fix: `currentVersion()` first, then the content; the entry is keyed by the version observed before it. Status: FIXED (refines D25).
- I-55 (item 2 + item 4b, major) `void record.env.dispose()` (eviction, sweep) and the worker's abort listener could reject unobserved; a throwing close killed the process under the default policy. Fix: `disposeRecord()` never rejects (`onDisposalError` hook with `{ key, tenantId, configRevision }`, default `console.error`; `stats().disposalFailures`); `stop().catch()` in the worker; `HylaApp.close()` collects Runtime disposal errors into the report (`{ unreleasedLeases, unsettledAttempts, errors }`) instead of rejecting. Verified in a child process with Node's default policy. Status: FIXED.

### Probe status after this round
- promise-lifecycle `06` (expected `rootEnvCount`/`liveEnvCount` 0 while an abandoned attempt is outstanding) now matches the behaviour: the bounded close detaches the Env (I-56). The other intended FAIL lines listed above are unchanged.

## Third review round (2026-09-05, two auditors on 6bb36c2; verified against aa196b5)

### Core line (`packages/core/tests/v05-review-lifecycle.test.mjs` R-5, `v05-cache-cleanup.test.mjs` R17 anchors, `v05-realms-override.test.mjs` R06/R07, `v05-explain.test.mjs` K12, `v05-definitions.test.mjs` R20, `core.test.mjs`)
- I-58 (C1, major) A Family referenced only through `Family.range()`, with no exact reference anywhere in the owner's closure, was unresolvable in a private realm (`MISSING_SERVICE`), contradicting API_REFERENCE's "exact and range alike"; R07 and the planning benchmark were seeded by an extra exact edge. Fix: a `ServiceRange` carries its `origin` (the revision `range()` was called on) and `requiredContractIds`; the compiler collects the origin like an exact dependency and `closureOf` follows range origins, so the candidates are {origin} ∪ owner closure ∪ admitted (public realm: admitted only); `dependencyIdentity` includes the origin key. R07 now has a range-only private Family; the benchmark's private helper is range-only. Status: FIXED (D35 supersedes D16; M-22).
- I-59 (C2, major) `Revision.range()` typed as the origin's full instance while the Runtime may satisfy the range with another revision of the Family. Fix: `ServiceRevision<Instance, PublicApi>`; a range types as the origin's Contract view (`ProvidedShape<Provides>`, `unknown` without `provides`); the Runtime keeps only candidates that provide the origin's Contracts and otherwise fails with `INCOMPATIBLE_IMPLEMENTATION` (backtrackable; `details.required`, `details.candidates`). Type tests in `type-tests/api.ts`, runtime case R07 (admitted 1.1.0 beats the private origin 1.0.0; 1.2.0 without the Contract is not a candidate). Status: FIXED (D36; M-23).
- I-60 (C3, critical) Plan-template keys omitted the lineage anchors and the hit path never re-solved: two gap Envs with identical signatures, one anchored and one not, shared a template, so plans depended on which lineage warmed the cache (a spurious `LINEAGE_UNIQUENESS_CONFLICT`, or silently the wrong revision). Fix: the key carries a digest of the parent's anchors (`familyId=revisionKey`, sorted; `anchors=none` otherwise, so keys of anchor-free worlds are unchanged); on a hit, a backtrackable failure of slot assignment evicts the template and solves afresh (defence in depth: it catches the conflict direction, the key catches both). Regression: R17 anchors (cold references, both orders, a forced stale hit). Status: FIXED (D37).
- I-61 (C4, major) `dispose()` issued before a setup deadline that then fired inside the grace: `settleSlot` saw the sequence settle (by timing out) and reported nothing, so the Env was finalized `disposed` while the raw setup still ran (the attempt was in the ledger, but no `UNSETTLED_ATTEMPT`, no `attempt-abandoned`, no `disposing`). Fix: when the sequence settles inside the grace, the slot's `unsettledAttempt` gets the remainder of the same grace and is then abandoned and reported like any other. Regression R-5 (plus a control whose deadline is longer than the grace). Status: FIXED (D38; M-18 amended).
- I-62 (C5, minor) `check()`/`explain()` were called "pure" while they register descriptors, consumed Env numbers and fill the plan cache; the registries are keyed by id and never shrink. Fix: planning ids come from their own counter (no Env id consumed); `inspect().definitions` exposes the registry sizes (entries/inputs/bindings/contracts/families), which are bounded by the static definition set (K01); wording fixed in runtime.ts, API_REFERENCE, SEMANTIC_MODEL §2 and SEMANTIC_CHANGES §8. Regression K12 (100 plans: no Env, one template, registries grow by exactly the distinct Entry, the next Env id is consecutive). Status: FIXED (D39; M-25).
- I-63 (C6, major) Two physical copies of one revision whose `setup` bodies differed canonicalized silently, first registered wins (asserted by R20 and core.test as intended behaviour). Fix: the structural signature includes a digest of `String(setup)`; a differing body is `DUPLICATE_DEFINITION` (`details.expected/actual`), textually identical copies still canonicalize. Captured state and native functions stay invisible to the comparison (documented limit). R20, core.test and the hardening metadata-drift case rewritten. Status: FIXED (D40; M-24).
- I-64 (C7/C9/C10, docs) SEMANTIC_MODEL §5 conflated an undeclared parameter (inherits) with an omitted declared key (`MISSING_INPUT`); PACKAGE_AUTHORING still taught the setup completion barrier; ADVERSARIAL_AUDIT recorded it without a v0.5 note; `preload()` was described as a distinct mechanism. Fix: wording; `preload()` marked `@deprecated` (it is `void ref.load().catch(() => undefined)`, kept as the structural discriminator of `loadAll`). No type-level thenable guard: the runtime `foreign-thenable-setup` diagnosis stays the boundary (D17). Status: FIXED (D41).
- I-65 (C8a, test) R06's `fresh: [Real]` assertion was vacuous (`derive()` exposes no `deps`, the fallback loaded the parent's instance and compared it with `undefined`). Fix: the test asserts the owners of the forked nodes (override target and its dependant in the derived Env, the Fake's private helper still shared), then enters the Entry in the fork and asserts a distinct instance that is still the Fake through every resolution path. C8b (F-PL-04 always waited for the timeout before disposing) is covered by R-5, which disposes first. Status: FIXED.

### Application line, site manager and host (`apps/hyla-mini/tests/site-manager.test.mjs` S2/S5/S6 and H11, `audit-app.test.mjs` S4/S9, `preflight.test.mjs` S8 and H01/S9, `review-app.test.mjs` S7, `helpers/repository-conformance.mjs`)
- I-66 (S2, major) An acquirer whose reservation turned out redundant (another acquirer inserted the record while it waited) decremented the reservation count without waking the queue, so a third acquirer waited on a free unit until `acquireTimeoutMs` (`SITE_CAPACITY`). Fix: `releaseReservation()` (decrement + `grantWaiter()`) at the redundant-reservation path and on both closed paths; the record-insertion path stays a plain decrement (the unit became a record). Regression S2 (gated configuration reads, three acquirers in one tick). S3 follow-up: the H11 working-set test now asserts `liveEnvCount − roots ≤ capacity` at every lease and in every heap sample (closing Envs included), samples `disposing`, and records `maxSiteEnvsAlive` in `working-set.json` (printed in VALIDATION). Status: FIXED.
- I-67 (S5, major) A stale configuration read (replica lag, a cached read racing a save) drained the tenant's newer SiteEnv and created one for the older revision; the generation was captured before the capacity wait, so an `invalidate()` during the wait produced a record stale from birth. Fix: rotation is monotonic: after the read, the newest live record by (generation, configRevision) is joined when it is newer than the read, only older records are drained; after the wait, a moved generation or a newer concurrent record releases the reservation and re-reads (bounded by `acquireTimeoutMs`). `SiteRecord.generation` is recorded. Regressions S5 (stale read once; invalidate during the wait). Status: FIXED (D42).
- I-68 (S6, minor) `LeasePurpose` was accepted and ignored: a build could take the last unit of capacity from live traffic. Fix: `reservedForRequests` (default `capacity ≥ 2 ? 1 : 0`, validated at startup); non-request purposes create a new SiteEnv only while more than that is free (joining an existing one needs no unit); `grantWaiter` serves the oldest request first and another purpose only when the free units exceed the reserve; `release()` closes an idle Env only when that serves the next eligible waiter; `stats()` reports `reservedForRequests` and `waitingByPurpose`. Regression S6 (two cases). Status: FIXED (D43; M-26).
- I-69 (S4, major) The worker's `runLoop` promise was unobserved: a throwing tick left the state at `running`, kept the worker world, and surfaced as an unhandled rejection under the default policy. Fix: the loop never rejects; a failure disposes the world first and then sets `failed` with `lastError`; `stop()` (also the Runtime's cleanup of the worker) rethrows it so it lands in `HylaApp.close().errors`; `start()` is allowed from `failed`; the abort signal only requests the wind-down. Regressions S4 (in-process; child process under the default unhandled-rejection policy exits 0 and reports the error). Status: FIXED (D44).
- I-70 (S7/S8, minor) `HylaApp.close()` swallowed a failing manager shutdown and flattened only one level of the Runtime's nested disposal report; `createHylaApp()` never checked the request budget, so an embedder that skipped `preflightRequests()` deployed without the third check. Fix: `close()` is idempotent (one report for every caller), pushes manager errors into `errors` and flattens the report to its leaves; startup explains one request from a synthetic `preflight` site world entered outside the manager (third `preflight` entry) and refuses a violation; the manager is created at startup. Fixture `violations.HeavyRequestHandler`. Regressions S8, S7, H06 (entries). Status: FIXED (D45; M-27).
- I-71 (S9, major) The domain table was loaded once at startup (a tenant saved later needed a restart) and `normalizeDomain` kept a trailing dot and did no IDNA, so `alpha.test.` and `bücher.example` were distinct claims from their canonical spellings. Fix: `refresh()` is single-flight; `refreshIfStale(minIntervalMs)`; `startHttpServer` reloads on an unknown host at most once per `domainRefreshMinIntervalMs` (default 1000 ms) before answering 404; the worker reloads on every tick (`start({ domains })`, failures counted in `refreshFailures`); `serve` passes the table; `normalizeDomain` strips one trailing dot, rejects anything but letters/digits/marks/dots/hyphens before IDNA (the URL host parser would cut `a/b.com` to `a`), then `url.domainToASCII`. Regressions S9 (two), H01/S9 unit cases, conformance `ALPHA.TEST.` on both backends. Status: FIXED (D46).
