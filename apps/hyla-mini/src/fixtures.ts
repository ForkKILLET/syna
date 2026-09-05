import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Category,
  Locale,
  NavigationItem,
  PostInput,
  Tag,
  ThemeSettings,
} from './domain/model.js'

export interface TenantFixture {
  readonly site: {
    readonly title: string
    readonly domains: readonly string[]
    readonly defaultLocale: Locale
    readonly theme: ThemeSettings
    readonly navigation: readonly NavigationItem[]
  }
  readonly categories: readonly Omit<Category, 'tenantId'>[]
  readonly tags: readonly Omit<Tag, 'tenantId'>[]
  readonly posts: readonly PostInput[]
}

export interface ContentFixture {
  readonly tenants: Readonly<Record<string, TenantFixture>>
}

export const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export function loadContentFixture(): ContentFixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, 'content.json'), 'utf8')) as ContentFixture
}
