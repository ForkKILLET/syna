export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: string
}

const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/

export function parseVersion(input: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(input.trim())
  if (!match) throw new TypeError(`Invalid semantic version: ${input}`)

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    ...(match[4] ? { prerelease: match[4] } : {}),
  }
}


export function normalizeVersion(input: string): string {
  const version = parseVersion(input)
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease ? `-${version.prerelease}` : ''}`
}

function comparePrerelease(
  left: string | undefined,
  right: string | undefined,
): number {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1

  const leftParts = left.split('.')
  const rightParts = right.split('.')
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1

    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) - Number(rightPart)
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart.localeCompare(rightPart)
  }
  return 0
}

function compareParsedVersions(
  left: ParsedVersion,
  right: ParsedVersion,
): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function compareVersions(left: string, right: string): number {
  return compareParsedVersions(parseVersion(left), parseVersion(right))
}

function compareTuple(
  version: ParsedVersion,
  target: ParsedVersion,
): number {
  if (version.major !== target.major) return version.major - target.major
  if (version.minor !== target.minor) return version.minor - target.minor
  return version.patch - target.patch
}

function satisfiesComparator(version: ParsedVersion, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator)
  if (!match) return false
  const operator = match[1] ?? '='
  const target = parseVersion(match[2]!)
  const comparison = compareParsedVersions(version, target)

  switch (operator) {
    case '>=': return comparison >= 0
    case '<=': return comparison <= 0
    case '>': return comparison > 0
    case '<': return comparison < 0
    case '=': return comparison === 0
    default: return false
  }
}

export function satisfiesVersion(versionText: string, rangeText: string): boolean {
  const version = parseVersion(versionText)
  const range = rangeText.trim()

  if (range === '' || range === '*' || range.toLowerCase() === 'latest') return true

  if (range.startsWith('^')) {
    const base = parseVersion(range.slice(1))
    const lower = compareTuple(version, base) >= 0

    if (base.major > 0) return lower && version.major === base.major
    if (base.minor > 0) {
      return lower && version.major === 0 && version.minor === base.minor
    }
    return lower && version.major === 0 && version.minor === 0 && version.patch === base.patch
  }

  if (range.startsWith('~')) {
    const base = parseVersion(range.slice(1))
    return compareTuple(version, base) >= 0
      && version.major === base.major
      && version.minor === base.minor
  }

  const wildcard = /^(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(range)
  if (wildcard) {
    const [major, minor, patch] = wildcard.slice(1)
    if (major !== 'x' && major !== '*' && version.major !== Number(major)) return false
    if (minor !== undefined && minor !== 'x' && minor !== '*' && version.minor !== Number(minor)) return false
    if (patch !== undefined && patch !== 'x' && patch !== '*' && version.patch !== Number(patch)) return false
    return true
  }

  if (/[<>]=?/.test(range)) {
    return range.split(/\s+/).filter(Boolean).every(part => satisfiesComparator(version, part))
  }

  return compareVersions(versionText, range) === 0
}
