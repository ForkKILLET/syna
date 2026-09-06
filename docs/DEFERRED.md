# Deferred (v0.6)

Things noticed during the v0.6 API consolidation that were **not** changed, because they are outside the rename list of the task book (命名) or because they would change behaviour (语义). Each entry says what was seen and where; none is a commitment.

## 命名 — names outside the list, left as they are

| # | Where | Observation | Kept because |
|---|---|---|---|
| N1 | `ImplementationDescriptor.persistentRef` | The task book suggested `ref`; `ImplementationCandidate` (which extends the descriptor) already has `ref: CandidateRef`, a different kind of reference (Phase A finding F1). | Two reference kinds must not share one field name on one object. `persistentRef` stays; only its type (`ImplementationRef`) and its key (`familyId`) changed (R5). |
| N3 | Error `details.site`, `details.deadlineMs`, `inspect().planCache.maxEntries` | R6 renamed only the policy-context field (`dependencySite`); M1 renamed only the options (`limits.setupDeadlineMs`, `limits.planCacheEntries`). Error details and inspection fields keep `site`, `deadlineMs`, `maxEntries`. | Outside the list, and the v0.5 snapshots pin these keys; renaming them would be a semantic-output change. |
| N4 | `benchmarks/v0.5-planning.mjs` case label `bound-entry-private-range-request-enter-dispose-100` | The case function and comment say `AnchoredEntry`; the result label keeps the 0.5 wording. | `scripts/benchmark-compare.mjs` matches cases by name against `benchmarks/results-v0.5.0-baseline-same-machine.json`; renaming the label would break the same-machine comparison the release depends on. |
| N5 | a name for `ServiceRef<T> \| InputRef<T>` | `DependencyRef<T>` — which in 0.6 meant this union and was deprecated — was removed in 0.7.0; `DependencyRefFor<D>` types the ref of a declared dependency. Whether the bare union deserves a name of its own is open. | No caller needs the union: `env.deps` is typed per dependency and `loadAll()` rejects Input refs structurally. Adding a name would be a public name outside the 0.7 task book. |
| N6 | `EntryCallArguments<E>` / `EntryRunCallArguments<E, Result>` | Module-level tuple aliases in `descriptors.ts` used by the `enter` / `run` overloads; not exported from the package entry. | M2 fixes the public names at `EntryParameters` and `EntryArguments`; exporting the tuples would add a public name outside the list. |
| N7 | `SynaError` is no longer a `class` | T1 makes `SynaError` a value (constructor) plus a union type; `class X extends SynaError` stops type-checking (nothing in this repository did it). | The task asks for a code-discriminated union; a class cannot be one. Recorded in the migration table. |

## 语义 — behaviour that looked wrong or improvable, left unchanged

| # | Where | Observation | Not done because |
|---|---|---|---|
| S2 | `env.state` vs GC, `inspect().unsettledAttempts` | An Env with an abandoned attempt stays `disposing` until the attempt settles; the ledger keeps every unsettled attempt. Whether a collected Env should leave the ledger is open. | §3.6. |
| S3 | `provides: [primary(C)]` | A default-implementation declaration (the `@Primary` counterpart) would remove most `MISSING_AUTO_POLICY` cases. | §3.6: no default implementations. |
| S4 | `C.all` coexistence | Every candidate is a real node of the current Env; a candidate whose setup fails still fails the collection's caller. | §3.6: no relaxation. |
| S5 | New dependency forms, Entry capabilities, Runtime options | Including `ServiceFamily.range()` (Phase A finding F2): `serviceRange(revision, range)` took a **revision** as the range's origin; a Family-level `range()` would be a range without an origin and would change private-realm resolution (0.5 third round C1/C2). | §3.6; D4 deleted `serviceRange` and added nothing. |
| S9 | `C.all` version resolution with several active revisions | With both `1.2.0` and `1.9.0` of a family active in one Env, `set.resolve({ version: '^1.0.0' })` picks the highest satisfying version (`1.9.0`); the deleted selector picked the active-ancestor revision (`1.2.0`) because only one was active in its world. | This is `C.all`'s existing rule (v0.5 `defaultRuntimePolicy`), recorded in the migration table under D3; not a change made this round. |
