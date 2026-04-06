export function unreachable(_: never): never {
  throw new Error('Unreachable.')
}