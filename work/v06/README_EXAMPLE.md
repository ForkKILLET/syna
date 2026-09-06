# README first-page example (v0.6 names)

Written before any rename (Phase A3). The three blocks are the files of one small program; `docs`-free, comment-free. They go verbatim into `README.md` ("Syna in one screen") in Phase D and are compiled and executed by `scripts/tests/readme-example.test.mjs` in Phase F. The zh-CN README carries the same three blocks.

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

Expected output when run (`node dist/main.js`):

```
1 [ 'greeter' ]
hello, world
false hello, world
```

## Places where a comment was tempting

- `reuse: { fresh: [Greeter] }` — the word "fresh" carries the meaning ("a new instance instead of the parent's"); no comment needed once the field is called `reuse` instead of `scope`.
- `own === shared` printing `false` — the demonstration of `reuse.fresh`; the line reads on its own.
- `plan.forks` — at the Runtime root every node is new, so the first entry shows the counts and the labels; no comment.
- The exact fork labels (`greeter` is the dependency name inside the Entry, not the Service id) are checked by the test in Phase F; if the label turns out to be the node id instead, the expected output is corrected, not the example.
