import { define } from '../../syna.js'

export interface ContentRootSettings {
  /** Absolute directory that contains one sub-directory per tenant. */
  readonly rootDir: string
}

export const ContentRoot = define.input<ContentRootSettings>('content-root', {
  metadata: { displayName: 'Filesystem content root' },
})
