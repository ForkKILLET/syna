# Syna

Syna is an immutable, scope-aware dependency-injection and capability-composition runtime for TypeScript. A Runtime admits a finite set of versioned Services. Entries create immutable Env worlds. Each Env has one canonical visible slot for each resolved node, reuses compatible ancestor slots by default, and materializes Service instances lazily or eagerly without allowing materialization order to change topology.

This repository is a hardened reference implementation of **Syna Core Semantic Model v0** and the refined **v0.4.0 API**.

## Why Syna

Syna is designed for systems such as Hyla/BASM and Fluida, where an application must derive many nested or parallel contexts without teaching the container what a “request”, “blog”, “transaction”, or “build” is.

The main invariants are:

- Runtime construction creates no Env, slot, or Service instance.
- Every Env is created by one Entry invocation.
- Runtime definitions and Env topology are immutable.
- Lazy loading affects only materialization time, never version choice, ownership, or identity.
- One Env has one canonical visible slot per resolved node.
- A changed dependency slot forks its reverse dependency closure.
- Structural dependency cycles are legal; setup-time wait cycles fail immediately.
- Multiple Service versions are first-class and may coexist.
- Inputs represent external, lifecycle-free contextual facts.
- Contracts have runtime nominal identity but no instance lifecycle.

## Package authoring

A package creates one definition scope from its own `package.json`:

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { definePackage } from '@syna/core'

export const define = definePackage(packageJson)
```

`package.json`:

```json
{
  "name": "@example/postgres",
  "version": "2.4.1",
  "type": "module",
  "imports": {
    "#syna/package": "./package.json"
  }
}
```

The exported Service name remains stable across upgrades; its exact revision comes from the package version:

```ts
export interface Postgres {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>
}

export interface PostgresConfig {
  connectionString: string
}

export const DatabaseConfig =
  define.input<PostgresConfig>('database-config')

export const Postgres = define.service({
  requires: {
    config: DatabaseConfig,
  },

  async setup({ config }, { onDispose }): Promise<Postgres> {
    const settings = await config.load()
    const pool = createPool(settings.connectionString)

    onDispose(() => pool.close())

    return {
      query: (sql, params = []) => pool.query(sql, params),
    }
  },
})
```

A dependency is an inert `DependencyRef<T>`. Calling `.load()` materializes its already-planned canonical slot and waits until it is ready.

## Contracts

```ts
export interface LlmConnector {
  complete(prompt: string): Promise<string>
}

export const Llm = define.contract<LlmConnector>('llm')

export const OpenAI = define.service('openai', {
  provides: [Llm],
  setup: (): LlmConnector => ({
    complete: async prompt => callOpenAI(prompt),
  }),
})
```

Contract dependency forms:

```ts
const Consumer = define.service('consumer', {
  requires: {
    strictDefault: Llm,
    policySelected: auto(Llm),
    selectable: Llm.selector,
    allTogether: Llm.all,
  },
  setup(deps) { /* ... */ },
})
```

- A naked Contract requires an unambiguous implementation family.
- `auto(C)` opts into the Runtime’s explicit auto-selection policy for that edge.
- `C.selector` freezes all candidates, preflights each as an independent child world, and reports `available` or `unavailable` without requiring candidates to coexist.
- `C.all` requires every admitted implementation revision to coexist in the current Env.

## Bindings

A Binding is a named business-level provider choice shared by multiple consumers:

```ts
export const SummaryLlm = define.binding('summary-llm', Llm)

const Summarizer = define.service('summarizer', {
  requires: { llm: SummaryLlm },
  setup({ llm }) {
    return {
      async summarize(text: string) {
        return (await llm.load()).complete(text)
      },
    }
  },
})
```

The host supplies a durable implementation preference at Entry time:

```ts
const ref = SummaryLlm.to(OpenAI)
```

For a `0.2.0` implementation the default intent is `^0.2.0`; for `2.4.1` it is `^2.4.1`.

## Entries and Envs

```ts
const AppEntry = define.entry('app', {
  requires: {
    database: Postgres,
  },
  parameters: {
    config: DatabaseConfig,
  },
})

const runtime = createRuntime({
  services: [Postgres],
})

await runtime.run(
  AppEntry,
  { config: { connectionString: 'postgres://localhost/app' } },
  async ({ database }) => {
    const db = await database.load()
    await db.query('select 1')
  },
)
```

A Service may depend on an Entry. It receives a `BoundEntry` anchored at that Service slot’s owner Env, allowing a Service to create typed child worlds without ambient access to an arbitrary “current Env”.

```ts
const UnitOfWork = define.service('unit-of-work', {
  requires: { transaction: TransactionEntry },
  setup({ transaction }) {
    return {
      async run(input, callback) {
        const entry = await transaction.load()
        return entry.run(input, async ({ tx }) => callback(await tx.load()))
      },
    }
  },
})
```

## Validation

```bash
npm install
npm run check
npm run test:coverage
npm run benchmark:v04
```

`npm run check` performs strict project compilation, compile-time API tests, the complete Node behavior suite, and all executable demos.

See:

- `docs/SEMANTIC_MODEL.md`
- `docs/API_REFERENCE.md`
- `docs/ARCHITECTURE.md`
- `docs/PACKAGE_AUTHORING.md`
- `docs/VALIDATION.md`
