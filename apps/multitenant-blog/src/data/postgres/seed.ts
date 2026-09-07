import type { ContentStore } from '../../domain/content.js'
import type { SiteAuthSettings, SiteConfig, SiteConfigInput } from '../../domain/model.js'
import type { ContentFixture, TenantFixture } from '../../fixtures.js'

/**
 * Writes one tenant's categories, tags and posts from the fixture inside the
 * store's unit of work. Idempotent in content: a second run leaves identical
 * data with every post revision incremented by one.
 */
export async function seedTenantContent(
  store: ContentStore,
  tenantId: string,
  fixture: TenantFixture,
): Promise<void> {
  await store.transaction(tenantId, async repository => {
    for (const category of fixture.categories) await repository.saveCategory(category)
    for (const tag of fixture.tags) await repository.saveTag(tag)
    for (const post of fixture.posts) await repository.savePost(post)
  })
}

export async function seedAllTenants(store: ContentStore, fixture: ContentFixture): Promise<void> {
  for (const [tenantId, tenant] of Object.entries(fixture.tenants)) {
    await seedTenantContent(store, tenantId, tenant)
  }
}

export interface SiteConfigExtras {
  readonly recipes: SiteConfig['recipes']
  readonly auth: SiteAuthSettings
}

/** Merges fixture site data with the recipe and auth documents another layer owns. */
export function siteConfigInputFromFixture(
  tenantId: string,
  fixture: TenantFixture,
  extras: SiteConfigExtras,
): SiteConfigInput {
  return {
    tenantId,
    title: fixture.site.title,
    domains: [...fixture.site.domains],
    defaultLocale: fixture.site.defaultLocale,
    theme: { ...fixture.site.theme },
    navigation: fixture.site.navigation.map(item => ({ ...item })),
    recipes: extras.recipes,
    auth: extras.auth,
  }
}
