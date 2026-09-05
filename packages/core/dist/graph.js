export function stronglyConnectedComponents(adjacency) {
    let index = 0;
    const indexes = new Map();
    const lowlinks = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];
    const visit = (node) => {
        indexes.set(node, index);
        lowlinks.set(node, index);
        index += 1;
        stack.push(node);
        onStack.add(node);
        for (const target of adjacency.get(node) ?? []) {
            if (!indexes.has(target)) {
                visit(target);
                lowlinks.set(node, Math.min(lowlinks.get(node), lowlinks.get(target)));
            }
            else if (onStack.has(target)) {
                lowlinks.set(node, Math.min(lowlinks.get(node), indexes.get(target)));
            }
        }
        if (lowlinks.get(node) === indexes.get(node)) {
            const component = [];
            while (true) {
                const member = stack.pop();
                onStack.delete(member);
                component.push(member);
                if (member === node)
                    break;
            }
            components.push(component);
        }
    };
    const allNodes = new Set(adjacency.keys());
    for (const targets of adjacency.values()) {
        for (const target of targets)
            allNodes.add(target);
    }
    for (const node of [...allNodes].sort()) {
        if (!indexes.has(node))
            visit(node);
    }
    const componentByNode = new Map();
    components.forEach((component, componentIndex) => {
        component.forEach(node => componentByNode.set(node, componentIndex));
    });
    return { components, componentByNode };
}
/**
 * Orders SCCs so that dependants are disposed before dependencies.
 * The input edge A -> B means A structurally depends on B.
 */
export function dependantFirstComponentOrder(adjacency, scc) {
    const componentEdges = new Map();
    const indegree = new Map();
    for (let i = 0; i < scc.components.length; i += 1) {
        componentEdges.set(i, new Set());
        indegree.set(i, 0);
    }
    for (const [source, targets] of adjacency) {
        const sourceComponent = scc.componentByNode.get(source);
        for (const target of targets) {
            const targetComponent = scc.componentByNode.get(target);
            if (sourceComponent === targetComponent)
                continue;
            const edges = componentEdges.get(sourceComponent);
            if (!edges.has(targetComponent)) {
                edges.add(targetComponent);
                indegree.set(targetComponent, indegree.get(targetComponent) + 1);
            }
        }
    }
    const available = [...indegree.entries()]
        .filter(([, degree]) => degree === 0)
        .map(([component]) => component)
        .sort((a, b) => a - b);
    const order = [];
    while (available.length > 0) {
        const component = available.shift();
        order.push(component);
        for (const target of componentEdges.get(component) ?? []) {
            const nextDegree = indegree.get(target) - 1;
            indegree.set(target, nextDegree);
            if (nextDegree === 0) {
                available.push(target);
                available.sort((a, b) => a - b);
            }
        }
    }
    return order;
}
//# sourceMappingURL=graph.js.map