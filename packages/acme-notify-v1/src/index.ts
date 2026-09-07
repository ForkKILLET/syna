import { Logger } from '@syna-demo/logger'
import { Notifier } from '@syna-demo/notify-contract'
import { CurrentTenant } from '@syna-demo/tenant-store'
import { define } from './syna.js'

/** The Acme client of SDK generation 1: `send()` only. */
export interface AcmeNotify extends Notifier {
  readonly sdk: 'acme-sdk-1'
}

let nextConnection = 1

/**
 * A provider client is a Service: it holds the tenant's credential and one
 * connection to the provider, and closes that connection when its world ends.
 * It reads the tenant from an Input, so every tenant world gets its own client.
 */
export const AcmeNotify = define.service({
  provides: [Notifier],
  requires: { tenant: CurrentTenant, logger: Logger },
  familyMetadata: {
    displayName: 'Acme Notify',
    description: 'Client of the fictional Acme notification API.',
    tags: ['vendor', 'fictional'],
  },
  revisionMetadata: {
    displayName: 'Acme SDK 1.x',
    description: 'Generation 1 of the SDK: one notification per call.',
    tags: ['legacy'],
  },
  async setup({ tenant, logger }, { onDispose }): Promise<AcmeNotify> {
    const { id, apiKey } = tenant.read()
    const log = await logger.load()
    const connection = nextConnection++
    let sent = 0

    log.info(`acme ${define.package.version}: connection #${connection} opened for ${id} with key ${apiKey}`)
    onDispose(() => log.info(`acme ${define.package.version}: connection #${connection} closed`))

    return {
      provider: 'Acme',
      providerVersion: define.package.version,
      sdk: 'acme-sdk-1',
      async send(notification) {
        sent += 1
        log.debug(`acme ${define.package.version}: ${id} sends ${notification.id} to ${notification.to}`)
        return {
          notificationId: notification.id,
          provider: 'Acme',
          providerVersion: define.package.version,
          receipt: `acme/1/${connection}-${sent}`,
        }
      },
    }
  },
})
