# Issues (counterexamples, expectation, repro, root cause, fix, re-verify, status)

Format: `### I-nn — title` then fields.

### I-01 — Input payload Promise is assimilated by `load()`
- Probe: work/v05/probes/v04-probes.mjs "R05 Input payload Promise identity preserved" → FAIL on v0.4 (`got "inner"`).
- Expected: `InputRef.read()` returns the very payload object (Promise, thenable, function, undefined).
- Root cause: `Materializer.resolveSlot` is `async` and returns the payload → await assimilates thenables.
- Fix: K05/D07 — sync `read()`, deprecated `load()` returns `Awaited<T>`. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-02 — Un-awaited `load()` inside setup adds a completion barrier to the caller
- Probe: "K07 un-awaited load() does not add a barrier" → FAIL (timeout 200ms).
- Root cause: `trackStrongOperation` + `drainStrongLoads` (ALS frame).
- Fix: D04/D05 remove barrier. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-03 — `catch` around a failing lazy backend cannot produce a degraded Ready consumer
- Probe: "R02 setup catch of lazy failing backend" → FAIL (`backend down` propagates).
- Root cause: same barrier — the tracked strong load rejects the caller after its own setup returned.
- Fix: D04. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-04 — `Promise.race` fallback is blocked by the slow dependency
- Probe: "R04 Promise.race fallback" → FAIL (timeout 300ms). Fix: D04. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-05 — BoundEntry invoked during owner activation returns a Ready child (fake Ready)
- Probe: "K02/H13 BoundEntry during owner activation" → FAIL (`child entered while owner activating (state=ready)`).
- Root cause: activation transactions (`allowActivatingAnchor`, wait edges) publish a child whose anchor is not Ready.
- Fix: D08 — reject with OWNER_NOT_READY. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-06 — Service-owned private Entry: exact root resolves, range root fails (MISSING_SERVICE)
- Probe: "R07 private range" → FAIL (`exact=tx range=ERR MISSING_SERVICE`).
- Root cause: `GraphBuilder` range case filters `admittedRevisions` only; realm ignored.
- Fix: D09 realm closure. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-07 — Hand-written semver rejects union ranges and misorders comparator sets
- Probe: "K06 semver" → FAIL (`1.x || 2.x` throws; `>=1.2.0 <2.0.0 || >=3.0.0` wrong).
- Fix: D03 — npm `semver`. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-08 — Rollback failure does not stop the retry sequence
- Observed by reading `runSetupSequence`: `mayRetry` ignores `cleanupErrors`. Expected (K08): a failed rollback ends the sequence.
- Fix: in Attempt sequencing. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).

### I-09 — Immediate CIRCULAR_MATERIALIZATION on a load-call cycle (over-eager)
- v0.4 probe passes only because the cycle is real; legal pre-fetch/race patterns are misreported (I-02/I-04 show why).
- Fix: D06 deadline diagnostics. Status: FIXED (core v0.5; probes work/v05/probes/v04-probes.mjs all PASS; regression tests pending in v05-*.test.mjs).
