import packageJson from '#syna/package' with { type: 'json' }
import {
  createRuntime, definePackage, loadAll, isSynaError,
  type DependencyRef, type EntryExplanation, type InputRef,
} from '@syna/core'

const define = definePackage(packageJson)

interface Greeter { greet(name: string): string }
const Greeting = define.contract<Greeter>('greeting')
const Config = define.input<{ readonly prefix: string }>('config')
const Deferred = define.input<Promise<number>>('deferred')

const Logger = define.service('logger', { setup: () => ({ lines: [] as string[] }) })
const GreeterImpl = define.service('greeter', {
  provides: [Greeting],
  requires: { config: Config, logger: Logger },
  async setup({ config, logger }) {
    const cfg: { readonly prefix: string } = config.read()          // InputRef.read(): synchronous, typed payload
    const inputRef: InputRef<{ readonly prefix: string }> = config
    void inputRef
    const log = await logger.load()
    return { greet: (name: string) => { log.lines.push(name); return `${cfg.prefix} ${name}` } }
  },
})
const Consumer = define.service('consumer', {
  requires: { greeter: GreeterImpl, byContract: Greeting, logger: Logger, deferred: Deferred },
  async setup({ greeter, byContract, logger, deferred }) {
    const raw: Promise<number> = deferred.read()                     // identity preserved: read() returns the Promise itself
    const legacy: number = await deferred.load()                    // DEPRECATED form must still compile: Awaited<Promise<number>> = number
    const batch = await loadAll({ greeter, logger })                 // Service refs only
    const g: Greeter = batch.greeter
    const viaContract = await byContract.load({ signal: AbortSignal.timeout(5000) })   // load({ signal })
    const ref: DependencyRef<Greeter> = byContract
    void ref
    return { run: () => `${g.greet('world')}|${viaContract.greet('x')}|${legacy}|${raw instanceof Promise}` }
  },
})

const Main = define.entry({
  requires: { consumer: Consumer, legacy: Greeting.selector },      // DEPRECATED Contract.selector must still compile
  parameters: { config: Config, deferred: Deferred },
})

const runtime = createRuntime({ services: [Logger, GreeterImpl, Consumer] })
const params = { config: { prefix: 'hi' }, deferred: Promise.resolve(7) }
const explanation: EntryExplanation = await runtime.explain(Main, params)
const result = await runtime.run(Main, params, async ({ consumer, legacy }) => {
  const selector = await legacy.load()
  return { out: (await consumer.load()).run(), candidates: selector.candidates.map(c => `${c.familyId}@${c.version}`) }
})
const missing = await runtime.explain(Main, { config: { prefix: 'x' } } as never)
let cancelled = 'none'
try {
  const env = await runtime.enter(Main, params)
  const controller = new AbortController(); controller.abort()
  await env.deps.consumer.load({ signal: controller.signal })
  await env.dispose()
}
catch (error) { cancelled = isSynaError(error) ? error.code : 'other' }
console.log(JSON.stringify({
  result,
  version: GreeterImpl.version, key: GreeterImpl.key, packageId: define.package.id,
  explainOk: explanation.ok,
  services: explanation.ok ? explanation.services : null,
  missing: missing.ok ? null : { code: missing.error.code, inputs: missing.missingInputs },
  cancelled,
}))
await runtime.dispose()
