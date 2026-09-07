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

Full documentation lives in the source workspace (not in this package): `docs/API_REFERENCE.md`, `docs/API_STABILITY.md`, `docs/MIGRATION_V07_TO_V08.md`, `docs/GLOSSARY.md`, `docs/MIGRATION_V06_TO_V07.md`, `docs/SEMANTIC_CHANGES_V07.md`, `docs/MIGRATION_V05_TO_V06.md`, `docs/SEMANTIC_MODEL.md`, `docs/SEMANTIC_CHANGES_V05.md` and `docs/MIGRATION_V04_TO_V05.md` of the Syna v0.8 source archive. The package ships `dist/` only; its type declarations carry no `@deprecated` item, and its public surface is frozen from 0.8.0, the last rename before 1.0 (`docs/API_STABILITY.md`). Node ≥ 22.
