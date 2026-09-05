export interface LabeledGraphNode {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly edges: ReadonlyMap<string, string>;
}
export interface StronglyConnectedComponents {
    readonly components: readonly (readonly string[])[];
    readonly componentByNode: ReadonlyMap<string, number>;
}
export declare function stronglyConnectedComponents(adjacency: ReadonlyMap<string, ReadonlySet<string>>): StronglyConnectedComponents;
/**
 * Orders SCCs so that dependants are disposed before dependencies.
 * The input edge A -> B means A structurally depends on B.
 */
export declare function dependantFirstComponentOrder(adjacency: ReadonlyMap<string, ReadonlySet<string>>, scc: StronglyConnectedComponents): readonly number[];
//# sourceMappingURL=graph.d.ts.map