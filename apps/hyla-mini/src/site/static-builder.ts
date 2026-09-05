import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
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

/** Records what a build wrote so the next build removes exactly that and nothing else. */
export const BUILD_MANIFEST_FILE = '.hyla-build.json'

interface PreviousBuild {
  readonly files: readonly string[]
}

async function readPreviousBuild(outputDir: string): Promise<PreviousBuild | undefined> {
  let text: string
  try {
    text = await readFile(path.join(outputDir, BUILD_MANIFEST_FILE), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { files?: unknown }).files)) {
    throw new TypeError(`${BUILD_MANIFEST_FILE} in ${outputDir} is not a Hyla build manifest.`)
  }
  const files = (parsed as { files: unknown[] }).files.filter((item): item is string => typeof item === 'string')
  return { files }
}

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
        const inside = (relative: string): string => {
          const target = path.resolve(outputDir, relative)
          if (!target.startsWith(outputDir + path.sep)) throw new Error(`Refusing to touch a path outside ${outputDir}: ${relative}`)
          return target
        }
        // The directory must be empty or hold a previous build of this builder.
        // Only files listed in that build's manifest are removed — never anything
        // else that happens to live there — and only directories they left empty.
        const previous = await readPreviousBuild(outputDir)
        const foreign = (await readdir(outputDir)).filter(entry => entry !== BUILD_MANIFEST_FILE)
        if (previous === undefined && foreign.length > 0) {
          throw new Error(`Static build outputDir ${outputDir} is not empty and holds no previous Hyla build (${BUILD_MANIFEST_FILE}); refusing to write into it.`)
        }
        if (previous !== undefined) {
          const directories = new Set<string>()
          for (const relative of previous.files) {
            const target = inside(relative)
            await rm(target, { force: true })
            let directory = path.dirname(target)
            while (directory.startsWith(outputDir + path.sep)) {
              directories.add(directory)
              directory = path.dirname(directory)
            }
          }
          for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
            await rmdir(directory).catch(() => undefined) // only succeeds when the directory is empty
          }
        }
        const files: string[] = []
        const pages: { path: string; kind: string; postIds: readonly string[] }[] = []
        const write = async (relative: string, content: string, meta?: { kind: string; postIds: readonly string[] }) => {
          const target = inside(relative)
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
        await writeFile(path.join(outputDir, BUILD_MANIFEST_FILE), `${JSON.stringify({
          builder: 'hyla-mini',
          tenantId: site.tenantId,
          configRevision: site.site.configRevision,
          generatedAt: new Date().toISOString(),
          files,
        }, null, 2)}\n`, 'utf8')
        return { tenantId: site.tenantId, configRevision: site.site.configRevision, outputDir, files, pages }
      },
    }
  },
})
