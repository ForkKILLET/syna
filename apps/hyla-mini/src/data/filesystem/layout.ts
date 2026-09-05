import { define } from '../../syna.js'
import type { Post } from '../../domain/model.js'

/**
 * Where a post file lives inside a tenant directory. Both layouts store the
 * stable record id in the file's front matter, so renames never lose identity.
 * Categories, tags and the site configuration keep their JSON form in both.
 */
export interface ContentLayout {
  readonly name: 'default' | 'blog'
  /** Relative path (POSIX separators) of a post file inside the tenant directory. */
  postPath(post: Pick<Post, 'slug' | 'primaryCategory'>): string
  /** Directories (relative to the tenant directory) that may contain post files. */
  readonly postRoots: readonly string[]
  /** Whether post directories are scanned recursively. */
  readonly recursive: boolean
}

export const ContentLayoutContract = define.contract<ContentLayout>('content-layout')

export const ContentLayoutChoice = define.binding('content-layout', ContentLayoutContract, {
  metadata: { displayName: 'Filesystem content layout' },
})

/** posts/<slug>.md */
export const DefaultLayout = define.service('default-layout', {
  provides: [ContentLayoutContract],
  setup(): ContentLayout {
    return {
      name: 'default',
      postRoots: ['posts'],
      recursive: false,
      postPath: post => `posts/${post.slug}.md`,
    }
  },
})

/** posts/<primaryCategory>/<slug>.md ; uncategorised posts go to posts/_uncategorized/. */
export const BlogLayout = define.service('blog-layout', {
  provides: [ContentLayoutContract],
  setup(): ContentLayout {
    return {
      name: 'blog',
      postRoots: ['posts'],
      recursive: true,
      postPath: post => `posts/${post.primaryCategory ?? '_uncategorized'}/${post.slug}.md`,
    }
  },
})
