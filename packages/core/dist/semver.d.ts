export interface ParsedVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    readonly prerelease?: string;
}
export declare function parseVersion(input: string): ParsedVersion;
export declare function normalizeVersion(input: string): string;
export declare function compareVersions(left: string, right: string): number;
export declare function satisfiesVersion(versionText: string, rangeText: string): boolean;
//# sourceMappingURL=semver.d.ts.map