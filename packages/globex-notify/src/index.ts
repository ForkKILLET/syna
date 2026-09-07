import { Logger } from '@syna-demo/logger'
import { Notifier } from '@syna-demo/notify-contract'
import { CurrentTenant } from '@syna-demo/tenant-store'
import { define } from './syna.js'

/** The Globex client: a second Family that provides the same Contract. */
export interface GlobexNotify extends Notifier {
  readonly region: string
}

let nextSession = 1

export const GlobexNotify = define.service({
  provides: [Notifier],
  requires: { tenant: CurrentTenant, logger: Logger },
  familyMetadata: {
    displayName: 'Globex Notify',
    description: 'Client of the fictional Globex notification API.',
    tags: ['vendor', 'fictional'],
  },
  revisionMetadata: {
    displayName: 'Globex client 3.x',
  },
  async setup({ tenant, logger }, { onDispose }): Promise<GlobexNotify> {
    const { id, apiKey } = tenant.read()
    const log = await logger.load()
    const session = nextSession++
    let sent = 0

    log.info(`globex ${define.package.version}: session #${session} opened for ${id} with key ${apiKey}`)
    onDispose(() => log.info(`globex ${define.package.version}: session #${session} closed`))

    return {
      provider: 'Globex',
      providerVersion: define.package.version,
      region: 'eu-west',
      async send(notification) {
        sent += 1
        log.debug(`globex ${define.package.version}: ${id} sends ${notification.id} to ${notification.to}`)
        return {
          notificationId: notification.id,
          provider: 'Globex',
          providerVersion: define.package.version,
          receipt: `globex/${session}-${sent}`,
        }
      },
    }
  },
})
