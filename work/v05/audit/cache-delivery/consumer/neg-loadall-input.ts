import packageJson from '#syna/package' with { type: 'json' }
import { definePackage, loadAll } from '@syna/core'
const define = definePackage(packageJson)
const Config = define.input<{ prefix: string }>('config')
const Minimal = define.service('minimal', { setup: () => ({ ping: () => 'pong' }) })
const S = define.service('s', {
  requires: { config: Config, minimal: Minimal },
  async setup({ config, minimal }) {
    await loadAll({ config })          // EXPECT ERROR: InputRef has no preload(); Inputs are read(), never batched
    minimal.read()                     // EXPECT ERROR: Service refs have no read()
    return {}
  },
})
void S
