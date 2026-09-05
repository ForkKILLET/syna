/**
 * Materialize a named group of dependency references concurrently.
 * The returned object preserves the input keys and inferred value types.
 */
export async function loadAll(refs) {
    const entries = await Promise.all(Object.entries(refs).map(async ([key, ref]) => [key, await ref.load()]));
    return Object.freeze(Object.fromEntries(entries));
}
//# sourceMappingURL=loading.js.map