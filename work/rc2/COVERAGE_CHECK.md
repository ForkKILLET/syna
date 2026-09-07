# rc.2 coverage check (COVERAGE_CHECK)

The four demos deleted in 1.0.0-rc.2 (`apps/minimal-demo`, `apps/features-demo`, `apps/hyla-demo`, `apps/fluida-demo`) asserted their own results (I-112). Before deleting them, every assertion is mapped to the core test that already proves it — file and test name, run and green on the rc.1 tree (`node --test --test-name-pattern=… <file>`, 2026-09-07) — or to the rc.2 demo that carries it from now on. Nothing is assumed covered.

## §2.3 — the four `features-demo` assertions

| # | `features-demo` assertion (`apps/features-demo/src/index.ts`, rc.1) | core test file | test name | what the test asserts |
|---|---|---|---|---|
| 1 | an eager Service starts during Entry activation: `assert.equal(eagerStartsAfterEnter, 1)` right after `runtime.enter(Root)` | `packages/core/tests/v05-cache-cleanup.test.mjs` | `K09 Ready means every locally owned eager slot is Ready; inherited eager slots are not restarted; closing refuses new work first` | after `runtime.enter(Root)` the event log is exactly `['eager-start']` and `root.state === 'ready'`; a child that reuses the eager slot adds no start |
| 1' | (same, the concurrent case) | `packages/core/tests/lifecycle.test.mjs` | `parallel eager setup has no ordering guarantee and can start concurrently` | both eager setups have started (`a-start`, `b-start`) while `enter()` is still pending; `enter()` resolves only after both ended |
| 1'' | (same, for `C.all`) | `packages/core/tests/contracts.test.mjs` | `Contract.all includes eager candidates and only eager ones materialize at activation` | at activation exactly the eager candidates of the collection have run their setup |
| 2 | destructuring a dependency ref is still lazy: `const { consumer } = root.deps; assert.equal(counterStartsBeforeLoad, 0)` | `packages/core/tests/core.test.mjs` | `ServiceRef is safely destructurable and materializes only when load() is called` | `const { service } = env.deps` leaves `starts === 0`; the first `load()` runs the setup once, the second returns the same instance (`starts === 1`) |
| 3 | a structural cycle is callable after setup: `assert.deepEqual([aSeesB, bSeesA], ['b', 'a'])` | `packages/core/tests/lifecycle.test.mjs` | `structural cycles are legal after setup; pending setup wait cycles hit the initialization deadline` (first half) | `A` and `B` require each other through `forward()`; `(await a.load()).callB()` is `'b'` and `(await b.load()).callA()` is `'a'` |
| 4 | a setup wait cycle is rejected: `assert.equal(codeOf(waitCycleError), 'LOAD_TIMEOUT')` and the message names the observed cycle | `packages/core/tests/lifecycle.test.mjs` | `structural cycles are legal after setup; pending setup wait cycles hit the initialization deadline` (second half) | `C` and `D` await each other in `setup`; `load()` rejects with `LOAD_TIMEOUT`, `details.suspectedWaitCycle` has three entries (`C.id`, `D.id`, back to the first) and the message says `observation, not a proof` |
| 4' | (same, timing and shape) | `packages/core/tests/v05-promises.test.mjs` | `R04 a genuinely pending wait cycle is reported by the initialization deadline with the observed load() cycle` | `LOAD_TIMEOUT` within the deadline (not a hang), `details.suspectedWaitCycle` is an array, `details.pendingLoads` non-empty, the message says `not a proof of deadlock` |
| 4'' | (same, through a Ready instance) | `packages/core/tests/hardening.test.mjs` | `a setup wait cycle routed through a Ready service ends with LOAD_TIMEOUT instead of hanging` | a wait that goes through a Ready instance's method is still ended by the deadline with `LOAD_TIMEOUT` naming the waiting revision |

One wording detail is not asserted by a core test: `features-demo` matched the message fragment `form a cycle` (`packages/core/src/internal/materializer.ts` builds `Observed load() calls form a cycle (…); this is an observation, not a proof of deadlock.`). The core tests assert the code, the `suspectedWaitCycle` contents and the `observation, not a proof` / `not a proof of deadlock` fragments of the same sentence. The message text is a diagnostic, not part of the frozen surface (`docs/API_STABILITY.md`), so no demo re-asserts the fragment; `apps/07-failure-modes` prints `details.suspectedWaitCycle` for the reader instead.

Conclusion for §2.3: all four are covered by core tests that exist today and pass; no gap, nothing to add to `01`–`07` for these four. (`07-failure-modes` still shows the wait-cycle diagnostic, because a reader asking "what happens when setup hangs" should see `suspectedWaitCycle` — that is teaching, not coverage.)

## The other assertions of the deleted demos

| deleted demo | assertion | covered by |
|---|---|---|
| `features-demo` | re-providing an Input forks the reverse closure (`childCounter.id !== rootCounter.id`) | `packages/core/tests/core.test.mjs` — `re-providing an Input forks exactly its reverse dependency closure`; shown by `apps/02-per-tenant` |
| `features-demo` | `runtime.inspect().liveEnvCount === 0` after disposal | every rc.2 demo asserts it at its end |
| `features-demo` | `LINEAGE_UNIQUENESS_CONFLICT` for a lineage-unique Family that diverges below its pin | `packages/core/tests/core.test.mjs`, `contracts.test.mjs`, `v05-cache-cleanup.test.mjs` (R17), `v05-planner.test.mjs`, `v06-t1-errors.test.mjs` (the code, the pinned slot and the conflict chain); not re-shown: `uniqueWithin: 'lineage'` is outside the seven questions of §2.2 |
| `minimal-demo` | `runtime.run()` with a parameter, `load()` inside the callback, `liveEnvCount 0` afterwards | `apps/01-basics` (`runtime.run`, `ServiceRef.load`, `onDispose` ran, `liveEnvCount 0`) |
| `hyla-demo` | one pool shared down the Env tree; a Binding's choice honoured per request world; every admitted `LlmConnector` revision visible through `C.all`; `catalog.implementations` lists them | `apps/02-per-tenant` (shared `TenantStore` across tenant worlds, `reuse: { share }`), `apps/03-user-configurable` (`Binding.to` / `parse`, `Contract.all` as the settings page), `apps/04-two-versions` (`catalog.implementations`, two revisions of one Family admitted together, `ServiceRevision.range`); core: `packages/core/tests/contracts.test.mjs` — `Contract.all exposes every admitted revision and shares canonical slots`, `Binding choices persist by family/range and are inherited by descendants`, `durable implementation refs serialize, parse and upgrade within their version intent` |
| `fluida-demo` | one pool shared by parallel transaction worlds created with `env.run()`; the transaction and repository of each world are distinct; `liveEnvCount 0` afterwards | `apps/05-scheduled-jobs` (the scheduler opens one digest world per tenant through its `AnchoredEntry`, in parallel; every world shares the one `TenantStore` pool and owns its own `DigestJob`; `run()` closes each world); core: `packages/core/tests/v05-realms-override.test.mjs` — `R08 an owner-bound Entry stays bound to its owner after inheritance; app-owned UoW never sees request Inputs; explicit parameters work; the handle causes no fresh`, `packages/core/tests/v04-regressions.test.mjs` — `a worker world is started by the host after the owner is Ready, not during eager setup` |

## Run record

```sh
node --test --test-name-pattern="ServiceRef is safely destructurable|re-providing an Input forks" packages/core/tests/core.test.mjs
node --test --test-name-pattern="structural cycles are legal after setup|parallel eager setup" packages/core/tests/lifecycle.test.mjs
node --test --test-name-pattern="K09 Ready means" packages/core/tests/v05-cache-cleanup.test.mjs
node --test --test-name-pattern="R04 a genuinely pending wait cycle" packages/core/tests/v05-promises.test.mjs
node --test --test-name-pattern="a setup wait cycle routed through a Ready service" packages/core/tests/hardening.test.mjs
node --test --test-name-pattern="Contract.all includes eager candidates" packages/core/tests/contracts.test.mjs
```

All green on the rc.1 tree (4a5a978) before any rc.2 change; the full `core-tests` step of the rc.2 release gate runs the same files again.
