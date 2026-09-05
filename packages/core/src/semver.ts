import semver from 'semver'

/**
 * Thin, deliberately small wrapper around the npm `semver` package. Syna ranges
 * select among revisions a deployer explicitly admitted, so prereleases that
 * were admitted participate in range matching (`includePrerelease: true`).
 * Version strings must be complete `major.minor.patch[-pre][+build]` values.
 */
const RANGE_OPTIONS = Object.freeze({ includePrerelease: true })

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (string | number)[]
  readonly version: string
}

export function parseVersion(input: string): ParsedVersion {
  const parsed = semver.parse(input.trim())
  if (!parsed) throw new TypeError(`Invalid semantic version: ${input}`)
  return Object.freeze({
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: Object.freeze([...parsed.prerelease]),
    version: parsed.version,
  })
}

export function normalizeVersion(input: string): string {
  return parseVersion(input).version
}

export function compareVersions(left: string, right: string): number {
  return semver.compare(parseVersion(left).version, parseVersion(right).version)
}

export function isValidRange(range: string): boolean {
  return semver.validRange(range, RANGE_OPTIONS) !== null
}

export function assertValidRange(range: string, subject = 'Version range'): string {
  if (semver.validRange(range, RANGE_OPTIONS) === null) {
    throw new TypeError(`${subject} is not a valid semver range: ${JSON.stringify(range)}`)
  }
  return range
}

export function satisfiesVersion(versionText: string, rangeText: string): boolean {
  const version = parseVersion(versionText).version
  const range = rangeText.trim()
  if (range === '' || range.toLowerCase() === 'latest') return true
  assertValidRange(range)
  return semver.satisfies(version, range, RANGE_OPTIONS)
}

export function caretRange(version: string): string {
  return `^${normalizeVersion(version)}`
}
