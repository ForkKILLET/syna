# @syna/core

Immutable, version-aware, scope-aware dependency injection and capability composition for Node.js and TypeScript.

```ts
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from '@syna/core'

const define = definePackage(packageJson)
const Name = define.input<string>('name')
const Greeter = define.service({
  requires: { name: Name },
  setup: async ({ name }) => ({ greet: async () => `Hello, ${await name.load()}` }),
})
const Main = define.entry({
  requires: { greeter: Greeter },
  parameters: { name: Name },
})

await using runtime = createRuntime({ services: [Greeter] })
await runtime.run(Main, { name: 'Syna' }, async ({ greeter }) => {
  console.log(await (await greeter.load()).greet())
})
```

Key API: `definePackage`, `define.service`, `define.contract`, `define.input`, `define.binding`, `define.entry`, `auto`, `override`, `loadAll`, and `createRuntime`.

`DependencyRef.load()` is a strong setup dependency. `DependencyRef.preload()` is explicit best-effort background warming. Runtime, Env, and implementation leases support async disposal.

See the workspace `docs/` directory for the semantic model, API reference, architecture, validation, and adversarial audit.
