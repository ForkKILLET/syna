import { stableJson, unwrapDependency } from './runtime-utils.js';
export const PUBLIC_REALM = Object.freeze({
    kind: 'public',
    id: 'public',
});
/**
 * A Service-owned Entry may expose exact private roots declared by that Entry.
 * Contract, auto, selector, all and range resolution remain public by design.
 */
export function privateEntryRealm(owner, dependencySite, entry) {
    const exactRoots = Object.entries(entry.requires)
        .map(([key, dependency]) => {
        const resolved = unwrapDependency(dependency);
        return resolved.kind === 'service-revision'
            ? [key, resolved.key]
            : undefined;
    })
        .filter((item) => item !== undefined);
    return Object.freeze({
        kind: 'private-entry',
        id: `private-entry:${owner.key}:${dependencySite}:${stableJson(exactRoots)}`,
    });
}
//# sourceMappingURL=resolution-realm.js.map