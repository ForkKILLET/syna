import { Logger } from '@syna-demo/logger'
import { Notifier, type Delivery, type Notification } from '@syna-demo/notify-contract'
import { CurrentTenant } from '@syna-demo/tenant-store'
import { define } from './syna.js'

export interface AcmeBatch {
  readonly batchId: string
  readonly deliveries: readonly Delivery[]
}

/** The Acme client of SDK generation 2: `send()` as before, plus batches. */
export interface AcmeNotify extends Notifier {
  readonly sdk: 'acme-sdk-2'
  sendBatch(notifications: readonly Notification[]): Promise<AcmeBatch>
}

let nextConnection = 1

/**
 * The same Family as `@syna-demo/acme-notify-v1` (same `syna.id`), one
 * generation later: the Contract it provides is unchanged, the instance grew
 * `sendBatch()`, and receipts look different.
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
    displayName: 'Acme SDK 2.x',
    description: 'Generation 2 of the SDK: single sends and batches.',
    tags: ['recommended'],
  },
  async setup({ tenant, logger }, { onDispose }): Promise<AcmeNotify> {
    const { id, apiKey } = tenant.read()
    const log = await logger.load()
    const connection = nextConnection++
    let sent = 0
    let batches = 0
    const deliver = (notification: Notification): Delivery => {
      sent += 1
      return {
        notificationId: notification.id,
        provider: 'Acme',
        providerVersion: define.package.version,
        receipt: `acme/2/${connection}-${sent}`,
      }
    }

    log.info(`acme ${define.package.version}: connection #${connection} opened for ${id} with key ${apiKey}`)
    onDispose(() => log.info(`acme ${define.package.version}: connection #${connection} closed`))

    return {
      provider: 'Acme',
      providerVersion: define.package.version,
      sdk: 'acme-sdk-2',
      async send(notification) {
        log.debug(`acme ${define.package.version}: ${id} sends ${notification.id} to ${notification.to}`)
        return deliver(notification)
      },
      async sendBatch(notifications) {
        batches += 1
        log.debug(`acme ${define.package.version}: ${id} sends a batch of ${notifications.length}`)
        return { batchId: `acme/2/batch-${connection}-${batches}`, deliveries: notifications.map(deliver) }
      },
    }
  },
})
