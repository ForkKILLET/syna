import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { define } from '../syna.js'
import { ANONYMOUS } from '../auth/principal.js'
import { SiteContext } from './context.js'
import { BuildOptions } from './inputs.js'

export interface StaticBuildManifest {
  readonly tenantId: string
  readonly configRevision: number
  readonly outputDir: string
  /** Relative file paths written, sorted. */
  readonly files: readonly string[]
  readonly pages: readonly { readonly path: string; readonly kind: string; readonly postIds: readonly string[] }[]
}

export interface StaticBuilder {
  build(): Promise<StaticBuildManifest>
}

const isSafeOutputDir = (dir: string): boolean => path.isAbsolute(dir) && dir.split(path.sep).filter(Boolean).length >= 2

/**
 * Renders the public site to files with the same renderer and pipelines the
 * HTTP path uses. Only what an anonymous visitor may see is written; drafts,
 * private posts, credentials and internal references never reach the output.
 */
export const StaticBuilder = define.service('static-builder', {
  requires: { context: SiteContext, options: BuildOptions },
  async setup({ context, options }): Promise<StaticBuilder> {
    const site = await context.load()
    const settings = options.read()
    if (!isSafeOutputDir(settings.outputDir)) {
      throw new TypeError(`Static build outputDir must be an absolute path with at least two segments, received ${settings.outputDir}.`)
    }
    return {
      async build() {
        const outputDir = settings.outputDir
        await mkdir(outputDir, { recursive: true })
        // Only remove what a previous build of this builder wrote.
        for (const entry of await readdir(outputDir)) {
          if (['index.html', 'posts', 'category', 'site.json'].includes(entry)) {
            await rm(path.join(outputDir, entry), { recursive: true, force: true })
          }
        }
        const files: string[] = []
        const pages: { path: string; kind: string; postIds: readonly string[] }[] = []
        const write = async (relative: string, content: string, meta?: { kind: string; postIds: readonly string[] }) => {
          const target = path.join(outputDir, relative)
          if (!target.startsWith(outputDir + path.sep)) throw new Error(`Refusing to write outside ${outputDir}: ${relative}`)
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, content, 'utf8')
          files.push(relative)
          if (meta) pages.push({ path: relative, ...meta })
        }

        const posts = await site.listPosts(ANONYMOUS)
        const index = await site.renderIndex(ANONYMOUS)
        await write('index.html', index.html, { kind: index.meta.kind, postIds: index.meta.postIds })
        for (const post of posts) {
          const page = await site.renderPost(post.slug, ANONYMOUS)
          if (!page) continue
          await write(path.join('posts', post.slug, 'index.html'), page.html, { kind: page.meta.kind, postIds: page.meta.postIds })
        }
        const categories = [...new Set(posts.flatMap(post => post.categories))].sort()
        for (const category of categories) {
          const page = await site.renderIndex(ANONYMOUS, category)
          await write(path.join('category', category, 'index.html'), page.html, { kind: page.meta.kind, postIds: page.meta.postIds })
        }
        await write('site.json', JSON.stringify({
          tenantId: site.tenantId,
          title: site.site.title,
          defaultLocale: site.site.defaultLocale,
          configRevision: site.site.configRevision,
          posts: posts.map(post => ({ id: post.id, slug: post.slug, title: post.title, locale: post.locale, categories: post.categories, tags: post.tags })),
        }, null, 2))
        files.sort()
        return { tenantId: site.tenantId, configRevision: site.site.configRevision, outputDir, files, pages }
      },
    }
  },
})
