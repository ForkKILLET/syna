import type { EntryDescriptor, ServiceRevision } from '../descriptors.js';
import type { ResolutionRealm } from './runtime-model.js';
export declare const PUBLIC_REALM: ResolutionRealm;
/**
 * A Service-owned Entry may expose exact private roots declared by that Entry.
 * Contract, auto, selector, all and range resolution remain public by design.
 */
export declare function privateEntryRealm(owner: ServiceRevision, dependencySite: string, entry: EntryDescriptor): ResolutionRealm;
//# sourceMappingURL=resolution-realm.d.ts.map