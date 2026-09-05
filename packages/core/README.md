# @syna/core

Immutable, scope-aware capability composition for TypeScript: a finite Runtime of versioned Services, Entry-created Env worlds, one canonical slot per resolved node, parent-only reuse, lazy or eager materialization with plain Promises, and `explain()` for every plan.

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from '@syna/core'

const define = definePackage(packageJson)
const Config = define.input<{ url: string }>('config')
const Database = define.service('database', {
  requires: { config: Config },
  setup: ({ config }, { onDispose }) => {
    const pool = connect(config.read().url)
    onDispose(() => pool.end())
    return pool
  },
})
const App = define.entry({ requires: { database: Database }, parameters: { config: Config } })

const runtime = createRuntime({ services: [Database] })
await runtime.run(App, { config: { url: '...' } }, async ({ database }) => (await database.load()).query('select 1'))
```

Full documentation lives in the source workspace (not in this package): `docs/API_REFERENCE.md`, `docs/SEMANTIC_MODEL.md`, `docs/SEMANTIC_CHANGES_V05.md` and `docs/MIGRATION_V04_TO_V05.md` of the Syna v0.5 source archive. The package ships `dist/` (with `.d.ts` files carrying the `@deprecated` markers) only. Node ≥ 22.
