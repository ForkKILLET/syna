import { define } from '../syna.js'
import type {
  Category,
  Post,
  PostFilter,
  PostInput,
  SiteConfig,
  SiteConfigInput,
  Tag,
} from './model.js'

/**
 * Tenant-scoped repository capability. Every implementation carries the tenant
 * constraint in every query; there is no cross-tenant read path.
 */
export interface ContentRepository {
  readonly tenantId: string
  listPosts(filter: PostFilter): Promise<readonly Post[]>
  getPost(slug: string, filter: Pick<PostFilter, 'visibility'>): Promise<Post | undefined>
  getPostById(id: string): Promise<Post | undefined>
  /** Upsert by id. Increments `revision`; slug/category renames keep the id. */
  savePost(input: PostInput): Promise<Post>
  deletePost(id: string): Promise<boolean>
  listCategories(): Promise<readonly Category[]>
  saveCategory(category: Omit<Category, 'tenantId'>): Promise<Category>
  listTags(): Promise<readonly Tag[]>
  saveTag(tag: Omit<Tag, 'tenantId'>): Promise<Tag>
  getSiteConfig(): Promise<SiteConfig | undefined>
  /**
   * Increments `configRevision`. Rejects (`DomainConflictError`) a configuration
   * that claims a domain another tenant of this store already owns.
   */
  saveSiteConfig(config: SiteConfigInput): Promise<SiteConfig>
  /**
   * Opaque token that changes whenever this tenant's posts, categories, tags or
   * configuration change through this store. Cheap to read; page caches key on
   * it so edits and visibility changes are never served stale.
   */
  contentVersion(): Promise<string>
}

/**
 * The minimal Fluida-style data-source adapter interface for this round. One
 * store instance lives at the app level (a shared pool or a shared root dir);
 * sites hold tenantised repository capabilities obtained from it.
 */
export interface ContentStore {
  readonly backend: 'postgres' | 'filesystem'
  forTenant(tenantId: string): ContentRepository
  listTenants(): Promise<readonly string[]>
  /**
   * Runs `work` against one tenant repository inside the backend's unit of
   * work. PostgreSQL: BEGIN/COMMIT on one leased client; rollback on throw.
   * Filesystem: per-tenant serialized mutation section; individual files are
   * replaced atomically but there is no multi-file atomicity.
   */
  transaction<T>(tenantId: string, work: (repository: ContentRepository) => Promise<T>): Promise<T>
  /** Removes every record of one tenant. Test helper; never called by request paths. */
  deleteTenant(tenantId: string): Promise<void>
}

export const ContentStoreContract = define.contract<ContentStore>('content-store')

/** Host-level choice of the content backend for one deployment. */
export const ContentBackend = define.binding('content-backend', ContentStoreContract, {
  metadata: { displayName: 'Content backend' },
})
