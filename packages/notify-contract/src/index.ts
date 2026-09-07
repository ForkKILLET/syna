import { define } from './syna.js'

/** One message to one recipient. */
export interface Notification {
  readonly id: string
  readonly to: string
  readonly subject: string
  readonly body: string
}

/** What a provider hands back once it accepted a notification. */
export interface Delivery {
  readonly notificationId: string
  readonly provider: string
  readonly providerVersion: string
  readonly receipt: string
}

/** The capability "can send a notification": every provider client implements it. */
export interface Notifier {
  readonly provider: string
  readonly providerVersion: string
  send(notification: Notification): Promise<Delivery>
}

export const Notifier = define.contract<Notifier>('notifier', {
  metadata: {
    displayName: 'Notifier',
    description: 'Can deliver one notification to one recipient.',
  },
})

/** The notification a delivery world is about: an external fact, fixed for that world. */
export const CurrentNotification = define.input<Notification>('current-notification', {
  metadata: { displayName: 'Current notification' },
})
