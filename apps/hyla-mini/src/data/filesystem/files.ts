import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

/** Thrown when a path would escape the content root or crosses a symlink. */
export class UnsafePathError extends Error {
  override readonly name = 'UnsafePathError'
}

/**
 * Joins `segments` under an absolute `root` and returns the absolute result.
 * Segments may contain forward slashes (layouts produce `posts/<cat>/<slug>.md`)
 * but no `..` or `.` parts, no absolute paths, no NUL bytes; the result must
 * stay inside `root`.
 */
export function safeJoin(root: string, ...segments: readonly string[]): string {
  if (!path.isAbsolute(root)) throw new UnsafePathError(`Root ${JSON.stringify(root)} must be absolute.`)
  const base = path.resolve(root)
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0 || segment.includes('\0')) {
      throw new UnsafePathError(`Invalid path segment ${JSON.stringify(segment)}.`)
    }
    if (path.isAbsolute(segment) || path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) {
      throw new UnsafePathError(`Absolute path segment ${JSON.stringify(segment)} is not allowed.`)
    }
    for (const part of segment.split(/[\\/]+/)) {
      if (part === '..' || part === '.') {
        throw new UnsafePathError(`Path segment ${JSON.stringify(segment)} must not contain ${JSON.stringify(part)}.`)
      }
    }
  }
  const resolved = path.resolve(base, ...segments)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new UnsafePathError(`Path ${JSON.stringify(resolved)} escapes root ${JSON.stringify(base)}.`)
  }
  return resolved
}

/** Relative path from `root` to `target` in POSIX form; both must come from safeJoin. */
export function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

/**
 * Symlink policy: nothing below the content root may be a symbolic link. Every
 * path component between `root` (exclusive; the root may legitimately live
 * under e.g. /var -> /private/var) and `target` (inclusive) is lstat'ed.
 * Components that do not exist yet are fine; a symlink anywhere throws.
 */
export async function assertNoSymlink(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target)
  if (relative === '') return
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    let stats
    try {
      stats = await lstat(current)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stats.isSymbolicLink()) {
      throw new UnsafePathError(`Refusing to use ${JSON.stringify(current)}: symbolic links are not allowed under the content root.`)
    }
  }
}

/** Reads a UTF-8 file, or returns undefined when it does not exist. */
export async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Writes `content` to a temporary file in the same directory and renames it
 * over `filePath`, so readers see either the old or the new content, never a
 * partial file. The parent directory is created if missing.
 *
 * Durability boundary (D65): this is a process-crash guarantee. Neither the
 * temporary file nor the directory is fsync'ed, so after a power loss or an
 * OS crash the rename may be durable while the data is not (an empty or
 * partial target), and a file written earlier (the content-version marker)
 * may be lost while a later write survives.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, filePath)
  }
  catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export interface FrontMatterDocument {
  readonly data: Readonly<Record<string, unknown>>
  readonly body: string
}

const FRONT_MATTER_OPEN = '---\n'
const FRONT_MATTER_CLOSE = /\n---(?:\n|$)/

/** Splits `---` delimited YAML front matter from the Markdown body. Without front matter `data` is empty. */
export function readFrontMatter(text: string): FrontMatterDocument {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (!normalized.startsWith(FRONT_MATTER_OPEN)) return { data: {}, body: normalized }
  const close = FRONT_MATTER_CLOSE.exec(normalized.slice(FRONT_MATTER_OPEN.length - 1))
  if (close === null) throw new SyntaxError('Front matter is not closed by a "---" line.')
  const yamlEnd = FRONT_MATTER_OPEN.length - 1 + close.index
  const parsed: unknown = YAML.parse(normalized.slice(FRONT_MATTER_OPEN.length, yamlEnd + 1))
  if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new SyntaxError('Front matter must be a YAML mapping.')
  }
  return {
    data: (parsed ?? {}) as Record<string, unknown>,
    body: normalized.slice(yamlEnd + close[0].length),
  }
}

export function writeFrontMatter(data: Readonly<Record<string, unknown>>, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0 })
  return `${FRONT_MATTER_OPEN}${yaml}---\n${body}`
}

/**
 * Per-key async mutex. Callers with the same key run strictly one after
 * another in call order; different keys never wait on each other.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await fn()
    }
    finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

const sharedMutex = new KeyedMutex()

/** Process-wide convenience instance of `KeyedMutex`. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return sharedMutex.withLock(key, fn)
}
