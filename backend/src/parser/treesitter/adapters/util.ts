// src/parser/treesitter/adapters/util.ts
// Shared helpers for tree-sitter adapters.

import type { Node as TSNode } from "web-tree-sitter";
import { FunctionNode, FunctionKind } from "../../../models/graph";

/** depth-first walk over named nodes; return false from fn to skip subtree */
export function walk(node: TSNode, fn: (n: TSNode) => boolean | void): void {
    const stack: TSNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        const descend = fn(current);
        if (descend === false) continue;
        for (let i = current.namedChildCount - 1; i >= 0; i--) {
            const child = current.namedChild(i);
            if (child) stack.push(child);
        }
    }
}

/** Builds FunctionNodes with collision-safe IDs (overloads, same-name methods). */
export class FunctionCollector {
    private usedIds = new Set<string>();
    readonly functions: FunctionNode[] = [];

    constructor(private filePath: string) {}

    add(params: {
        name: string;
        startLine: number;
        endLine: number;
        isExported: boolean;
        isDeclaration?: boolean;
        isRecovered?: boolean;
        isAsync?: boolean;
        kind: FunctionKind;
        calls: string[];
        parentId?: string;
    }): FunctionNode {
        let id = `${this.filePath}::${params.name}`;
        if (this.usedIds.has(id)) {
            id = `${id}@${params.startLine}`; // overload / duplicate name
        }
        this.usedIds.add(id);

        const fn: FunctionNode = {
            id,
            name: params.name,
            filePath: this.filePath,
            startLine: params.startLine,
            endLine: params.endLine,
            isExported: params.isExported,
            isDeclaration: params.isDeclaration,
            isRecovered: params.isRecovered,
            isAsync: params.isAsync,
            kind: params.kind,
            parentId: params.parentId,
            calls: params.calls,       // RAW NAMES — builder resolves to IDs
            calledBy: [],
            // recovered-from-ERROR nodes are heuristic (text-scanned body); flag low so
            // the UI badges them rather than implying a clean parse.
            analysisConfidence: params.isRecovered ? "low" : "medium",
        };
        this.functions.push(fn);
        return fn;
    }

    /** start lines of every function captured so far (for additive-pass dedup). */
    capturedStartLines(): Set<number> {
        return new Set(this.functions.map((f) => f.startLine));
    }
}

// ── Control-flow keywords that the C/C++ grammar sometimes mis-captures as a
// function name when a macro-heavy body corrupts the parse (e.g. a stray
// `switch (...) { }` surfacing as a function_definition named "switch").
// No real function legitimately has these names, so they're safe to drop.
const CONTROL_FLOW_NAMES = new Set([
    "if", "for", "while", "switch", "return", "catch", "else", "do", "sizeof",
]);

export function isControlFlowName(name: string): boolean {
    return CONTROL_FLOW_NAMES.has(name);
}

/** Extract raw call names inside a subtree (callNodeType varies per grammar). */
export function extractCallNames(
    node: TSNode,
    callNodeType: string,
    functionField: string,
    nameFromCallee: (callee: TSNode) => string | null
): string[] {
    const calls = new Set<string>();
    walk(node, (n) => {
        if (n.type === callNodeType) {
            const callee = n.childForFieldName(functionField);
            if (callee) {
                const name = nameFromCallee(callee);
                if (name) calls.add(name);
            }
        }
    });
    return [...calls];
}

/** is this path inside a directory commonly used for tests? */
export function inTestDir(relativePath: string): boolean {
    const segments = relativePath.toLowerCase().split("/");
    return segments.some((s) =>
        s === "test" || s === "tests" || s === "testing" ||
        s === "__tests__" || s === "spec" || s === "unittests" || s === "unit_tests"
    );
}

/** Walk up ancestors to the nearest node whose type is in `types`. */
export function nearestEnclosing(node: TSNode, types: Set<string>): TSNode | null {
    let a = node.parent;
    while (a) {
        if (types.has(a.type)) return a;
        a = a.parent;
    }
    return null;
}

/**
 * ERROR-tolerant function sweep. Some files are too malformed for a structured
 * descent (tree-sitter emits ERROR nodes — e.g. nlohmann/json's extreme C++
 * templates), so the normal namespace -> class -> function walk can't enter the
 * ERROR-wrapped bodies and finds nothing. This flat-walks the WHOLE tree
 * (passing through ERROR nodes) and calls `handle` for every function-like node.
 * Intended as a fallback only when the structured pass found 0 functions on a
 * parse that has errors.
 */
export function sweepFunctionsOnError(
    root: TSNode,
    fnTypes: Set<string>,
    handle: (node: TSNode) => void
): void {
    walk(root, (n) => {
        if (fnTypes.has(n.type)) handle(n);
    });
}
