# Syna v0.7 + Hyla-mini

Syna is an immutable, scope-aware capability-composition runtime for TypeScript. A Runtime admits a finite set of versioned Services; Entries create Env worlds; each Env has one canonical visible slot per resolved node, reuses its **parent's currently visible** slots by default, and materializes Service instances lazily or eagerly with plain Promises.

Hyla-mini (`apps/hyla-mini`) is the narrow but complete multi-tenant blog engine that drove this release: real PostgreSQL and real filesystem backends × dynamic HTTP and static builds, three Markdown recipes sharing one set of remark/rehype factory slots, two tenants with domain mapping and replaceable authentication, and a bounded, leased SiteEnv working set.

This repository is the v0.7 source workspace: `packages/core` (runtime), `packages/tsconfig` (TS presets), demo packages under `packages/*` and `apps/*-demo`, `apps/hyla-mini`, `benchmarks`, `scripts` and `docs`.

## Requirements

- Node.js ≥ 22 (developed and validated on Node 26; CI matrix 22/24)
- npm (workspaces + `package-lock.json`; the only package manager used here)
- PostgreSQL 17 client/server binaries (`initdb`, `pg_ctl`, `psql`) for the real-database tests, or a test database URL in `SYNA_TEST_PG_URL`. Docker is not required.

## Install, build, test

```sh
npm ci
npm run build          # tsc -b for every package and app; never trust a checked-in dist (there is none)
npm run typecheck      # strict project build + compile-time API tests
npm test               # core behaviour/regression suites (node:test)
```

Application, tooling and PostgreSQL tests:

```sh
npm run test:app        # Hyla-mini on the filesystem backend, site manager, preflight, review and audit regressions
npm run test:scripts    # gate tooling, deprecation list, no-old-names scan, README example, any-count budget
npm run test:postgres   # real PostgreSQL: a temporary cluster is created under work/pg and removed afterwards
```

Acceptance orchestrator (transparent runner; every sub-command is spawned and recorded with exit code, timing, TAP counts and log path):

```sh
node scripts/verify-v07.mjs --dev       # G0: build, type tests, core, real PostgreSQL/FS, app matrix, tooling, API inventory (0 deprecated items) + diff against the 0.6.0 record, any budget, demos, benchmarks + same-session comparison with 0.6.0
node scripts/verify-v07.mjs --release   # G0 + G1: source archive, rebuild from the archive in an empty directory, pack + consumer smoke, RELEASE_MANIFEST.json + validation/v0.7-release/SHA256SUMS.txt
```

`--release` prints `COMPLETE`, `PARTIAL` or `BLOCKED` and exits 0 only on `COMPLETE`. A missing PostgreSQL never becomes a skip; it is `BLOCKED`.

## Four-cell Hyla-mini demo

```sh
# filesystem backend on a scratch root
node apps/hyla-mini/bin/hyla-mini.mjs demo --root /tmp/hyla-content
# PostgreSQL backend on a temporary cluster
node scripts/pg-test-cluster.mjs with -- node apps/hyla-mini/bin/hyla-mini.mjs demo --backend postgres
# development server (seeds fixtures when empty, runs the startup preflight, starts the worker)
node apps/hyla-mini/bin/hyla-mini.mjs serve --root /tmp/hyla-content --port 8080
curl -H 'Host: alpha.test' http://127.0.0.1:8080/posts/shared-slug
curl -H 'Host: beta.test'  http://127.0.0.1:8080/posts/shared-slug
# static build of one tenant
node apps/hyla-mini/bin/hyla-mini.mjs build --root /tmp/hyla-content --tenant alpha --out /tmp/hyla-alpha
# explain one request world and its fork budget
node apps/hyla-mini/bin/hyla-mini.mjs explain --root /tmp/hyla-content --tenant alpha
```

Stop the server with Ctrl-C (the worker stops, site environments drain, shared resources close last). Clean up with `rm -rf /tmp/hyla-content /tmp/hyla-alpha` and `node scripts/pg-test-cluster.mjs stop` if a cluster was left running (`SYNA_PG_KEEP=1`).

## Syna in one screen

One program, four files; `npm run test:scripts` compiles and runs them exactly as printed here (`scripts/tests/readme-example.test.mjs`).

`package.json`

```json
{
  "name": "greeter",
  "version": "1.0.0",
  "type": "module",
  "imports": { "#syna/package": "./package.json" }
}
```

`src/greeter.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)

export const Audience = define.input<{ name: string }>('audience')

export const Greeter = define.service({
  requires: { audience: Audience },
  setup({ audience }) {
    const { name } = audience.read()
    return { greet: () => `hello, ${name}` }
  },
})
```

`src/conversation.ts`

```ts
import type { Runtime } from '@syna/core'
import { Audience, Greeter, define } from './greeter.js'

export const Conversation = define.entry('conversation', {
  requires: { greeter: Greeter },
  parameters: { audience: Audience },
})

export const Aside = define.entry('aside', {
  requires: { greeter: Greeter },
  reuse: { fresh: [Greeter] },
})

export async function converse(runtime: Runtime) {
  const world = await runtime.enter(Conversation, { audience: { name: 'world' } })
  const shared = await world.deps.greeter.load()
  console.log(shared.greet())

  const aside = await world.enter(Aside)
  const own = await aside.deps.greeter.load()
  console.log(own === shared, own.greet())

  await world.dispose()
}
```

`src/main.ts`

```ts
import { createRuntime } from '@syna/core'
import { Conversation, converse } from './conversation.js'
import { Greeter } from './greeter.js'

const runtime = createRuntime({
  services: [Greeter],
  limits: { setupDeadlineMs: 5_000, disposalGraceMs: 1_000 },
})

const plan = await runtime.explain(Conversation, { audience: { name: 'world' } })
if (plan.ok) console.log(plan.services.new, plan.forks.map(fork => fork.label))

await converse(runtime)
await runtime.dispose()
```

`node dist/main.js` prints:

```
1 [ 'greeter/input/audience/v1', 'greeter@1.0.0' ]
hello, world
false hello, world
```

Key rules: `serviceRef.load()` is an ordinary Promise (catch, race and background loads work as JavaScript defines them); a Service-owned `AnchoredEntry` needs a Ready owner (`OWNER_NOT_READY` otherwise); reuse is parent-only; `explain()` tells you which nodes a child would inherit, create or fork and why.

## Documentation

- `docs/SEMANTIC_MODEL.md` — the core model (v0.7 wording; §11 and §13 revised in 0.7.0, everything else unchanged since v0.5)
- `docs/SEMANTIC_CHANGES_V07.md` — what v0.7 keeps, clarifies, revises and withdraws, with test references
- `docs/API_REFERENCE.md` — `@syna/core` public API, with the per-code error details
- `docs/API_STABILITY.md` — the frozen surface (the 1.0 candidate surface from 0.7.0), the one-minor deprecation policy and the naming guidelines
- `docs/MIGRATION_V06_TO_V07.md` — the 23 removed aliases with their replacements, the permanent serialized key, the error-code mapping tables and the S1/S2 behaviour differences with the user-code patterns to check
- `docs/DEFERRED.md` — what was noticed and deliberately left alone
- `docs/MIGRATION_V05_TO_V06.md`, `docs/SEMANTIC_CHANGES_V05.md`, `docs/MIGRATION_V04_TO_V05.md` — the earlier migrations and the v0.5 semantic changes
- `docs/ARCHITECTURE.md` — module boundaries as implemented
- `docs/HYLA_MINI.md`, `docs/PLUGIN_AUTHORING.md` — the application and its plugin protocol
- `docs/AUDIT.md`, `docs/VALIDATION.md` — independent audit findings and the recorded validation run
- `work/v05/`, `work/v06/`, `work/v07/` — execution ledgers (STATE, DECISIONS, ACCEPTANCE, ISSUES; the v0.6 and v0.7 API inventories, the rename plan and the v0.7 proposal) and the review rounds' probes before archiving. Repository-only: the source archive produced by `scripts/verify-v07.mjs --release` contains `packages/`, `apps/`, `benchmarks/`, `docs/`, `scripts/` and the root files, never `work/`; documents in the archive that cite `work/v05/…` refer to this repository, and the archived audit probes live under `docs/audit/`.

## Status

This workspace does not publish to npm and does not push to any remote. Release artifacts (source archives and package tarballs under `work/release/`, `RELEASE_MANIFEST.json`, `validation/v0.7-release/SHA256SUMS.txt`) are produced locally by `node scripts/verify-v07.mjs --release`. The root `SHA256SUMS.txt` belongs to the task documents that ship with the workspace and is not touched by the tooling.
