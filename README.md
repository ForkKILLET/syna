# Syna

[![CI](https://github.com/synajs/syna/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/synajs/syna/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md) · Source: [github.com/synajs/syna](https://github.com/synajs/syna) · Issues: [github.com/synajs/syna/issues](https://github.com/synajs/syna/issues) · Version 1.0.0-rc.2 of `@syna/core` and `@syna/tsconfig` (the public surface is frozen from 0.8.0, `docs/API_STABILITY.md`; the line from the tarball baselines to 1.0 is `docs/HISTORY.md`)

Syna composes the pieces of a TypeScript program — a connection pool, a provider client, a request handler — into worlds that open and close cleanly. You declare each piece once, with what it needs and how it starts; Syna decides which world creates it, which worlds share it and when it closes. One tenant's pieces stay apart from another's without a scope object, a pool exists once, and a provider chosen by a user or replaced in a test is a declaration, not a rewrite.

The model in one paragraph: a Runtime admits a finite set of versioned Services; Entries open Env worlds; each world has one visible slot per resolved piece, reuses its parent's slots by default, and materializes Service instances lazily or eagerly with plain Promises. `docs/SEMANTIC_MODEL.md` is the model, `docs/GLOSSARY.md` the vocabulary, `docs/API_REFERENCE.md` the surface.

## Requirements

- Node.js ≥ 22 (developed and validated on Node 26; CI matrix 22/24)
- npm (workspaces + `package-lock.json`; the only package manager used here)
- PostgreSQL 17 client/server binaries (`initdb`, `pg_ctl`, `psql`) for the real-database tests of the reference application, or a test database URL in `SYNA_TEST_PG_URL`. Docker is not required.

## Install, build, test

```sh
npm ci
npm run build          # tsc -b for every package, example and app; never trust a checked-in dist (there is none)
npm run typecheck      # strict project build + compile-time API tests
npm test               # core behaviour/regression suites (node:test)
```

Application, tooling and PostgreSQL tests:

```sh
npm run test:app        # the reference application on the filesystem backend, site manager, preflight, review and audit regressions
npm run test:scripts    # gate tooling, deprecation list, no-old-names and vendor-name scans, README example, any-count budget
npm run test:postgres   # real PostgreSQL: a temporary cluster is created under work/pg and removed afterwards
```

## The seven examples

`apps/01-basics` … `apps/07-failure-modes`: one fictional domain — a multi-tenant notification delivery service — one question each, in reading order. Every program asserts its own results, exits non-zero when one fails, prints the stable lines its README lists, and is a step of the release gate. `docs/EXAMPLES.md` has the organisation, the fixtures, the naming rule and the declaration that the manual's snippets are cut from these programs.

| example | the question it answers |
|---|---|
| `apps/01-basics` | How do I define the pieces of a service, connect them, and run them in a world that opens and closes cleanly? |
| `apps/02-per-tenant` | Each tenant needs its own provider client and outbox while the pool and the logger stay shared — without a named scope. |
| `apps/03-user-configurable` | Let a tenant choose its provider, store the choice, and get that provider on the next request. |
| `apps/04-two-versions` | The provider shipped SDK 2.x; tenants that chose it under 1.x keep working while new tenants get 2.x. |
| `apps/05-scheduled-jobs` | A scheduler inside the service opens one digest world per tenant, typed and closed when done. |
| `apps/06-testing` | Replace the real provider in an integration test without touching the program under test. |
| `apps/07-failure-modes` | What happens when a setup fails, hangs, or the world closes under it — and what do I read? |

```sh
npm run demo        # builds, then runs all seven; each ends with `<name>: OK`
npm run demo:03     # one of them
```

## Syna in one screen

One program, four files; `npm run test:scripts` compiles and runs them exactly as printed here (`scripts/tests/readme-example.test.mjs`). It is the shape of `apps/02-per-tenant` and `apps/03-user-configurable` on one screen: two providers behind one Contract, a tenant that is a fact of the world its pieces live in, a choice stored as JSON and read back.

`package.json`

```json
{
  "name": "notify",
  "version": "1.0.0",
  "type": "module",
  "imports": { "#syna/package": "./package.json" }
}
```

`src/notify.ts`

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)

export interface Notifier { send(to: string, text: string): string }
export const Notifier = define.contract<Notifier>('notifier')
export const CurrentTenant = define.input<{ id: string; apiKey: string }>('current-tenant')

export const Acme = define.service('acme', {
  provides: [Notifier],
  requires: { tenant: CurrentTenant },
  setup({ tenant }) {
    const { apiKey } = tenant.read()
    return { send: (to: string, text: string) => `acme(${apiKey}) → ${to}: ${text}` }
  },
})

export const Globex = define.service('globex', {
  provides: [Notifier],
  setup() {
    return { send: (to: string, text: string) => `globex → ${to}: ${text}` }
  },
})
```

`src/outbox.ts`

```ts
import type { Runtime } from '@syna/core'
import { CurrentTenant, Notifier, define } from './notify.js'

export const Preferred = define.binding('preferred', Notifier)

export const Outbox = define.service('outbox', {
  requires: { notifier: Preferred, tenant: CurrentTenant },
  async setup({ notifier, tenant }) {
    const provider = await notifier.load()
    const { id } = tenant.read()
    return { deliver: (text: string) => provider.send(`owner@${id}.test`, text) }
  },
})

export const TenantEntry = define.entry('tenant', {
  requires: { outbox: Outbox },
  parameters: { tenant: CurrentTenant, notifier: Preferred },
})

export async function deliver(runtime: Runtime, id: string, stored: string) {
  const notifier = Preferred.parse(JSON.parse(stored))
  const tenant = { id, apiKey: `key-${id}` }
  return runtime.run(TenantEntry, { tenant, notifier }, async ({ outbox }) => (await outbox.load()).deliver('welcome'))
}
```

`src/main.ts`

```ts
import { createRuntime } from '@syna/core'
import { Acme, Globex } from './notify.js'
import { Outbox, Preferred, TenantEntry, deliver } from './outbox.js'

const runtime = createRuntime({ services: [Acme, Globex, Outbox] })

const settings = { 'acme-corp': JSON.stringify(Preferred.to(Acme)), 'globex-fans': JSON.stringify(Preferred.to(Globex)) }
console.log(settings['globex-fans'])

const plan = await runtime.explain(TenantEntry, { tenant: { id: 'acme-corp', apiKey: 'key-acme-corp' }, notifier: Preferred.to(Acme) })
if (plan.ok) console.log(plan.services.new, plan.forks.map(fork => fork.label).join(', '))

for (const [id, stored] of Object.entries(settings)) console.log(await deliver(runtime, id, stored))
await runtime.dispose()
```

`node dist/main.js` prints:

```
{"kind":"implementation-ref","contractId":"notify/notifier/v1","familyId":"notify/globex","range":"^1.0.0"}
2 notify/binding/preferred/v1->notify/acme@1.0.0, notify/input/current-tenant/v1, notify/acme@1.0.0, notify/outbox@1.0.0
acme(key-acme-corp) → owner@acme-corp.test: welcome
globex → owner@globex-fans.test: welcome
```

What the four lines say: a stored choice is JSON with exactly one shape (`Binding.to()` writes it, `parse()` refuses anything else); `explain()` tells before anything is created which pieces a world would create or fork and why (two Services here, plus the tenant fact and the choice the world provides); each tenant world gets its own `Outbox` and the provider it chose, from one Runtime. `serviceRef.load()` is an ordinary Promise; reuse is parent-only; a Service-owned `AnchoredEntry` needs a Ready owner (`OWNER_NOT_READY` otherwise).

## Reference application

`apps/multitenant-blog` (`@syna-app/multitenant-blog`) is the narrow but complete multi-tenant blog engine that drove the kernel: real PostgreSQL and real filesystem backends × dynamic HTTP and static builds, three Markdown recipes sharing one set of remark/rehype factory slots, two tenants with domain mapping and replaceable authentication, and a bounded, leased working set of site worlds. `docs/MULTITENANT_BLOG.md` documents it and `docs/PLUGIN_AUTHORING.md` its plugin protocol; read the examples first, the application when a question is about scale, resources or an operating boundary.

```sh
# three cells — HTTP alpha, HTTP beta, static alpha — on the filesystem backend; exit 1 unless every cell answers 200 with the tenant's page
npm run demo:multitenant-blog
# the same on the PostgreSQL backend, on a temporary cluster
node scripts/pg-test-cluster.mjs with -- node apps/multitenant-blog/bin/multitenant-blog.mjs demo --backend postgres
# development server (seeds fixtures when empty, runs the startup preflight, starts the worker)
node apps/multitenant-blog/bin/multitenant-blog.mjs serve --root /tmp/blog-content --port 8080
curl -H 'Host: alpha.test' http://127.0.0.1:8080/posts/shared-slug
curl -H 'Host: beta.test'  http://127.0.0.1:8080/posts/shared-slug
# static build of one tenant; explain one request world and its fork budget
node apps/multitenant-blog/bin/multitenant-blog.mjs build --root /tmp/blog-content --tenant alpha --out /tmp/blog-alpha
node apps/multitenant-blog/bin/multitenant-blog.mjs explain --root /tmp/blog-content --tenant alpha
```

Stop the server with Ctrl-C (the worker stops, site environments drain, shared resources close last). Clean up with `rm -rf /tmp/blog-content /tmp/blog-alpha` and `node scripts/pg-test-cluster.mjs stop` if a cluster was left running (`SYNA_PG_KEEP=1`).

## Release gate

Acceptance orchestrator (transparent runner; every sub-command is spawned and recorded with exit code, timing, TAP counts and log path):

```sh
node scripts/verify-release.mjs --dev       # G0: build, type tests, core, the application on real PostgreSQL/FS and its matrix, tooling, API inventory (0 deprecated items; identical to the 0.8.0 record — the frozen surface — and unchanged since 1.0.0-rc.1), codemod idempotency, old-token and vendor-name scans, any budget, the seven examples, the three-cell demo, benchmarks + same-session comparison with 1.0.0-rc.1 (both sides under --no-maglev)
node scripts/verify-release.mjs --release   # G0 + G1: source archive, rebuild from the archive in an empty directory (suites, examples and demo again), pack + consumer smoke, RELEASE_MANIFEST.json + validation/v<version>-release/SHA256SUMS.txt (the version is read from package.json)
```

`--release` prints `COMPLETE`, `PARTIAL` or `BLOCKED` and exits 0 only on `COMPLETE`. A missing PostgreSQL never becomes a skip; it is `BLOCKED`.

## Documentation

- `docs/EXAMPLES.md` — the seven examples: organisation, the fixtures, the naming rule (fictional names; a real product's name only where the code really interacts with it), the manual's snippets come from the examples
- `docs/SEMANTIC_MODEL.md` — the core model (v0.8 wording; §11 and §13 revised in 0.7.0, the names of 0.8.0, everything else unchanged since v0.5)
- `docs/SEMANTIC_CHANGES_V07.md` — what v0.7 keeps, clarifies, revises and withdraws, with test references
- `docs/API_REFERENCE.md` — `@syna/core` public API, with the per-code error details
- `docs/API_STABILITY.md` — the frozen public surface: no compatibility promise before 1.0, frozen from 0.8.0 (the last rename), changed only by a major from 1.0; the naming guidelines
- `docs/PACKAGE_AUTHORING.md` — how a package declares its Services, Contracts, Inputs and Bindings, and keeps its exports stable across versions
- `docs/MIGRATION_V07_TO_V08.md` — the last rename before 1.0, item by item (types, fields, values and events, structure), the codemod `scripts/codemod-v08.mjs`, the one serialized shape of an implementation reference and the names deliberately left alone
- `docs/GLOSSARY.md` — the vocabulary (Env, Entry, pinned, anchored, reused, inherited, materialize, load timeout) in English and Chinese
- `docs/MIGRATION_V06_TO_V07.md` — the 23 removed aliases with their replacements, the permanent serialized key, the error-code mapping tables and the S1/S2 behaviour differences with the user-code patterns to check
- `docs/DEFERRED.md` — what was noticed and deliberately left alone
- `docs/MIGRATION_V05_TO_V06.md`, `docs/SEMANTIC_CHANGES_V05.md`, `docs/MIGRATION_V04_TO_V05.md` — the earlier migrations and the v0.5 semantic changes
- `docs/ARCHITECTURE.md` — module boundaries as implemented
- `docs/MULTITENANT_BLOG.md`, `docs/PLUGIN_AUTHORING.md` — the reference application and its plugin protocol
- `docs/AUDIT.md`, `docs/VALIDATION.md` — independent audit findings and the recorded validation run (`docs/VALIDATION.md` is generated from the release run after the run and committed with it; repository-only, not in the source archive)
- `docs/HISTORY.md` — the line from the 0.2–0.4 tarball baselines to 1.0: each round with its task book and its semantic-change or migration document, the earlier names of the application and the demos
- `work/tasks/` — the task books and goals of the 0.6, 0.7, 0.8 and 1.0.0-rc.2 rounds (the 0.5 ones are the root `SYNA_V05_*` files, listed in the root `SHA256SUMS.txt`); `work/v05/`, `work/v06/`, `work/v07/`, `work/v08/`, `work/v1.0/`, `work/rc2/` — execution ledgers (STATE, DECISIONS, ACCEPTANCE, ISSUES; the v0.6, v0.7 and v0.8 API inventories, the rename plans, the v0.7 proposal, the v0.8 rename table and codemod reports, the rc.2 demo plan and coverage check) and the review rounds' probes before archiving. Repository-only: the source archive produced by `scripts/verify-release.mjs --release` contains `packages/`, `apps/`, `benchmarks/`, `docs/` (without `docs/VALIDATION.md`), `scripts/` and the root files, never `work/`; documents in the archive that cite `work/v05/…` refer to this repository, and the archived audit probes live under `docs/audit/`.

## Status

1.0.0-rc.2 is prepared in this repository and not published to npm; the tooling never publishes, tags or pushes. Release artifacts (source archives and package tarballs under `work/release/`, `RELEASE_MANIFEST.json`, `validation/v<version>-release/SHA256SUMS.txt`) are produced locally by `node scripts/verify-release.mjs --release`, and a release's evidence — the manifest, its validation directory and `docs/VALIDATION.md` generated from it — is committed together with the release. The root `SHA256SUMS.txt` belongs to the v0.5 task documents that ship with the workspace and is not touched by the tooling.
