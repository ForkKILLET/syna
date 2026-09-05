import assert from 'node:assert/strict'
import packageJson from '#syna/package' with { type: 'json' }
import { createRuntime, definePackage } from '@syna/core'

const define = definePackage(packageJson)

const Name = define.input<string>('name')

interface Greeter {
  greet(): Promise<string>
}

const Greeter = define.service({
  requires: { name: Name },
  setup({ name }): Greeter {
    return {
      async greet() {
        return `Hello, ${await name.load()}!`
      },
    }
  },
})

const Main = define.entry({
  requires: { greeter: Greeter },
  parameters: { name: Name },
})

const runtime = createRuntime({ services: [Greeter] })

const greeting = await runtime.run(Main, { name: 'Syna' }, async ({ greeter }) => (await greeter.load()).greet())
console.log(greeting)
const liveEnvs = runtime.inspect().liveEnvCount
await runtime.dispose()

// The demo checks its own result (I-112): exit 0 alone proves only the absence of a crash.
assert.equal(greeting, 'Hello, Syna!')
assert.equal(liveEnvs, 0)
console.log('demo: OK')
