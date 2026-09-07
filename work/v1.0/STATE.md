# Syna 1.0.0-rc.1 — working state

No task book: the release candidate changes metadata, tooling and documents; `packages/core` is the 0.8.0 source unchanged (baseline 0.8.0 = commit e24859f, the final 0.8 evidence commit; `work/v08/STATE.md`). The list is the 1.0.0-rc.1 entry of `CHANGELOG.md`, the line from the tarball baselines to 1.0 is `docs/HISTORY.md`. Commit messages follow `type(scope): subject` from this release on.

## The commits

- 277fb96 `chore(tasks)`: the task books and goals of 0.6 to 0.8 committed under `work/tasks/` (the 0.5 pair stays at the root, listed by the root `SHA256SUMS.txt`); the ledgers of those rounds say so. The gate's git provenance is clean from here on.
- c33d5af `build(gate)`: `scripts/verify-release.mjs` (the 0.8 gate reading the version from `package.json`; `api-inventory-diff` against `validation/v0.8-release/api-inventory.json`; the must-pass step `api-inventory-frozen`; the same-session comparison against e24859f; `docs/VALIDATION.md` neither fingerprinted nor archived), `scripts/benchmark-same-session.mjs` and `scripts/benchmark-compare.mjs` under `--expose-gc --no-maglev` on both sides with the flags recorded and compared, `benchmarks/results-v0.8.0-baseline-same-machine.json` (the 0.8.0 side of the recording below), `scripts/tests/api-inventory.test.mjs` (identity with the 0.8.0 record), `scripts/validation-doc.mjs`, `validation/README.md`, `.github/workflows/ci.yml` (the version step, the artifact name and path from `package.json`, the recorded cloud execution named with its repository `github.com/synajs/syna-v05`). `scripts/verify-v08.mjs` stays as the record of the 0.8.0 gate (`npm run verify:v08`).
- 1f3bc55 `docs(release)`: `docs/HISTORY.md`; `docs/API_STABILITY.md` — the way an unknown or renamed option is refused is a diagnostic, not part of the frozen surface; `docs/DEFERRED.md` 命名（2.0） N15 (`catalog.revisions(family)` returns version strings where the other two catalog reads return records); `packages/core/README.md` points at the repository.
- 77d6440 `build(release)`: version 1.0.0-rc.1 for the workspace (`syna-workspace`), `@syna/core` and `@syna/tsconfig`, every workspace dependency and the lockfile (`npm install --package-lock-only`: no further change); `repository` / `homepage` / `bugs` → `github.com/synajs/syna` in the three `package.json` files; the verify scripts; `CHANGELOG.md`; both READMEs (CI badge, repository and issue links, language links, the gate commands, the evidence protocol, `docs/HISTORY.md` in the index; the Chinese README's stale `verify-v07` commands replaced).
- The release commit (the commit that carries this ledger): the gate evidence of the execution on 77d6440 — `RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.1-release/` — and `docs/VALIDATION.md` generated from it. Nothing else.

Not in scope and not done: no change under `packages/core`; the `any` budget stays at `scripts/any-baseline-v0.7.0.json` (the last recorded baseline; 0.8.0 and this source measure the same 178); `docs/VALIDATION.md`'s v0.4 comparison section is unchanged; no tag, no push, no publish. Found and reported, not changed: no `syna-v05` link exists in any current document (the only occurrences of the string are the `syna-v05-compat` marker lines and the 0.5 ledger's note about the old remote).

## The protocol from 1.0.0-rc.1 on — one gate execution, one release commit

The 0.5–0.8 releases needed two gate executions and two evidence commits because `docs/VALIDATION.md`, generated from a manifest, was itself fingerprinted and archived. Now the gate excludes `docs/VALIDATION.md` from the fingerprint and from the archive (`listSourceFiles()` in `scripts/verify-release.mjs`): the gate runs once on the committed source (git provenance clean: `dirty: false`, no modified and no untracked file), `docs/VALIDATION.md` is generated from that manifest, and the manifest, the validation directory and the document are committed together in the release commit. A commit cannot contain its own hash, so the manifest names the commit it verified (77d6440, the last preparation commit); the fingerprint and the archive hashes it records hold on the release commit as well, because that commit adds only the evidence and the generated document.

## The bimodal p95 under `--no-maglev` — the recording of the 0.8.0 baseline (2026-09-07)

`node scripts/benchmark-same-session.mjs --commit e24859f --baseline-label 0.8.0 --runs 21 --out-dir <scratch>` on the c33d5af tooling (before the version bump; the core is the same source on both sides): 21 interleaved rounds, both benchmark processes under `--expose-gc --no-maglev`. The 0.6–0.8 mechanism (`work/v08/STATE.md`, the bimodal-p95 section: a benchmark process fast or slow for its whole timed loop, a TurboFan tier-up race that `--no-maglev` reproduced 12/12 at the slow mode's p95) holds: every process of both sides sat at the former slow mode's p95 level with the fast mode's p50.

| side | processes with p95 ≥ 0.25 ms (of 21) | p95 min – max | p50 mean |
|---|---:|---|---:|
| 0.8.0 (e24859f) | 21 | 0.2758 – 0.3333 ms | 0.1845 ms |
| rc.1 tooling, same core | 21 | 0.2744 – 0.3192 ms | 0.1834 ms |

Result: 23 / 23 tolerance rows within ±10 % (largest delta +2.2 %, `phase-breakdown-300.disposeMs.p95Ms`; the formerly bimodal row −1.7 %), 116 / 116 equality rows equal. `benchmarks/results-v0.8.0-baseline-same-machine.json` is the 0.8.0 side's median with a `source` note. Tolerance, statistic (element-wise median of the rounds) and round count unchanged; `scripts/benchmark-compare.mjs` reports two records measured under different V8 flags as not comparable (environment row `node flags`). The budget measurement of the gate (`benchmark-v0.5.json`) is still made without the flag.

## The release gate on 77d6440 — COMPLETE

`node scripts/verify-release.mjs --release` alone, nothing else running (log in the session scratchpad):

- `COMPLETE`, started 2026-09-07T05:20:40.352Z, generated 2026-09-07T05:25:05.827Z, 43 steps ok of 43, 894 test executions (447 distinct cases, 447 re-executed in the rebuilt copy), 894 passed, 0 failed steps, 0 skipped; source fingerprint `e90606c5432d235146db6306d7cab3cca66712ae040a1eebfebade0e7520b2ae` (353 files; `docs/VALIDATION.md` excluded); git provenance commit `77d644042273079a9108776357a471c907ec1ea3`, `dirty: false`, no modified and no untracked file; PostgreSQL PostgreSQL 17.10 at `postgres://syna@127.0.0.1:54329/postgres` (temporary cluster); Node v26.0.0.
- `api-inventory-no-deprecated`: 374 items, 0 @deprecated. `api-inventory-diff` against the 0.8.0 record: 374 items in the record, 374 here — 0 added, 0 removed, 0 changed in signature, 0 changed in JSDoc only, 0 newly deprecated. `api-inventory-frozen`: 374 items here, 374 in the 0.8.0 record (validation/v0.8-release/api-inventory.json, commit 38a722e); 0 of the record's items changed or removed, 0 items new or changed.
- `benchmark-compare` (same session against e24859f, both sides under `--expose-gc --no-maglev`): 23 / 23 tolerance rows within ±10 % (largest delta +3.8 %, `cases.phase-breakdown-300.materializationMs.p95Ms`), 116 / 116 equality rows equal; `cases.site-enter-tenant-input-reverse-closure-200.timing.p95Ms` 0.2912 → 0.2907 ms (-0.2 %); processes with p95 ≥ 0.25 ms: 21 / 21 of 21 (0.8.0 / rc.1), p95 range 0.2797 – 0.3303 / 0.2821 – 0.3300 ms, p50 mean 0.1815 / 0.1806 ms. Record drift (informational): this execution's 0.8.0 side against `benchmarks/results-v0.8.0-baseline-same-machine.json` 22 / 23 within ±10 %; outside: `cases.phase-breakdown-300.materializationMs.p50Ms` 0.0332 → 0.0294 (-11.4 %).
- `codemod-idempotent` and `rebuild-codemod-idempotent`: 0 edits, 0 hand sites; `no-old-reference-tokens`: 56 files scanned, 0 hits; `any-count` exit 0 against `scripts/any-baseline-v0.7.0.json`; `gate-self-tests` 26 / 26 (the no-old-names scan, the README example, the inventory assertions against the 0.7.0 and the 0.8.0 records, the codemod fixture, the `any` budget, the step runner, the cluster script); `consumer-smoke-result` on the packed tarballs: `{"result":84,"revision":"7.3.1","explainOk":true,"missing":"smoke.consumer/input/answer/v1","abandoned":0,"revisions":"7.3.1","slots":"ready,ready"}`.
- Archives (`validation/v1.0.0-rc.1-release/SHA256SUMS.txt`):
  - `work/release/syna-v1.0.0-rc.1-source.tar.gz` 798905 bytes sha256 `b21be1af36e175158c4dfcbdce9a4b1dfcbcf48a8df27b7f720aa8ec35982f07`
  - `work/release/syna-v1.0.0-rc.1-source.zip` 1002733 bytes sha256 `90007e367e0d5b189431db861b64b79cefb9a3e4bad79c20f44bb193eef46c6d`
  - `work/release/pack/syna-core-1.0.0-rc.1.tgz` 112554 bytes sha256 `244fad55295a94611584a528ff1f0d42dca3c52aa39166cd70aa834f7a0d4afa`
  - `work/release/pack/syna-tsconfig-1.0.0-rc.1.tgz` 1573 bytes sha256 `bc95719cb90684fe0c42ce9827185cd059906c18f9b3420d5395b5ea0de984c6`
- `docs/VALIDATION.md` generated from this manifest by `node scripts/validation-doc.mjs`; `RELEASE_MANIFEST.json` is this manifest.

## Acceptance (the goal's success conditions, each with its evidence)

- The gate, rebuilt from the final archive, prints COMPLETE: the manifest above (`rebuild-*` steps inside the unpacked `syna-v1.0.0-rc.1-source.tar.gz`, `pack-*`, `consumer-*`), exit 0.
- Provenance `dirty: false`: `manifest.environment.gitProvenance` — `modified: []`, `untracked: []` (the task documents are committed under `work/tasks/`).
- Inventory 374 items, 0 `@deprecated`, zero difference from the 0.8.0 record: `api-inventory-no-deprecated`, `api-inventory-diff` (0 / 0 / 0 / 0 / 0) and `api-inventory-frozen` above; `scripts/tests/api-inventory.test.mjs` asserts the same identity in `gate-self-tests` and, against the 0.7.0 record, that the 0.8 diff is still exactly the rename table.
- Benchmark within ±10 % of the re-recorded 0.8.0 baseline: `benchmark-compare` above (the same-session 0.8.0 side is the re-measurement; the record drift is the comparison with the committed file).
- The core untouched: no commit of this release changes a file under `packages/core/src`, `packages/core/tests` or `packages/core/type-tests` (`git diff --stat e24859f..HEAD -- packages/core/src packages/core/tests packages/core/type-tests` is empty); the only files of the package that changed are `packages/core/package.json` (version, repository metadata) and `packages/core/README.md` (the repository link). The reference planner differential and the explain/inspect snapshots ran unchanged inside `core-tests` and `rebuild-core-tests`.
- No tag, no push, no publish.

## Reproduce

- Suites: `npm run typecheck && npm test && npm run test:scripts && npm run test:app && npm run test:postgres` (then `git checkout -- work/v05/working-set.json; rm -rf apps/hyla-mini/work`).
- Gate: `node scripts/verify-release.mjs --release` alone (about five minutes; PostgreSQL 17 binaries or `SYNA_TEST_PG_URL`; the git history with e24859f for the same-session comparison, else the recorded file on this machine). Then `node scripts/validation-doc.mjs` and commit `RELEASE_MANIFEST.json`, `validation/v1.0.0-rc.1-release/` and `docs/VALIDATION.md` together. The step logs under `validation/v1.0.0-rc.1-release/logs/` stay untracked (`*.log` is ignored, as for the 0.6–0.8 evidence): four of them print the host's home directory, and the manifest carries every step's exit code, counts and timing.
- The baseline recording: `node scripts/benchmark-same-session.mjs --commit e24859f --baseline-label 0.8.0 --runs 21 --out-dir <dir>`; the 0.8.0 side is `<dir>/baseline-v0.8.0-same-session.json`. Mode split: over `<dir>/{baseline-runs,current-runs}/run-*.json`, `cases[].timing.p95Ms` of `site-enter-tenant-input-reverse-closure-200`.
- Inventory identity by hand: `node scripts/api-inventory.mjs --json <file>` and compare `items` with `validation/v0.8-release/api-inventory.json`.
