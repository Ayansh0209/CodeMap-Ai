// Extracts all functions and call relationships from a single source file
// Only runs on files < 500KB (mode: "full")

import {
    SourceFile,
    SyntaxKind,
    Node,
    FunctionDeclaration,
    ArrowFunction,
    FunctionExpression,
    MethodDeclaration,
} from "ts-morph";
import { FunctionNode, Visibility, FunctionKind, StructureNode } from "../models/schema";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFunctionId(relativePath: string, functionName: string): string {
    return `${relativePath}::${functionName}`;
}

function isExported(node: Node): boolean {
    return node
        .getDescendantsOfKind(SyntaxKind.ExportKeyword)
        .length > 0 ||
        node.getFirstAncestorByKind(SyntaxKind.ExportDeclaration) !== undefined;
}

// ── Test framework detection ─────────────────────────────────────────────────
//
// Covers all major JS/TS test frameworks:
//   Jest, Vitest, Mocha, Jasmine, Ava, Tape, node:test, QUnit
//
// Pattern breakdown:
//   [xf]?  — optional x (skip) or f (focused/only) prefix: xdescribe, fdescribe, fit, xit
//   it|test|describe|suite|context|specify — core verbs across frameworks
//   before/after + optional Each/All — lifecycle hooks
//
// This is intentionally NOT a hardcoded list of framework-specific functions.
// Any framework that uses these naming conventions is automatically supported.

const TEST_CALL_PATTERN = /^([xf]?(it|test|describe|suite|context|specify)|(before|after)(Each|All)?)$/;

// ── Call expression extraction ───────────────────────────────────────────────
// Finds all function calls made inside a given node's body
// Returns raw call names — resolved to IDs by chunkProcessor

function extractCallNames(node: Node): string[] {
    const calls = new Set<string>();

    node.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((call) => {
        const expr = call.getExpression();
        const text = expr.getText().trim();

        // skip empty or overly complex expressions
        if (!text || text.length > 100) return;

        // skip built-ins that aren't user functions
        const SKIP_CALLS = new Set([
            "console.log", "console.error", "console.warn", "console.info",
            "JSON.parse", "JSON.stringify",
            "Object.keys", "Object.values", "Object.entries", "Object.assign",
            "Array.from", "Array.isArray",
            "Math.floor", "Math.ceil", "Math.round", "Math.max", "Math.min",
            "parseInt", "parseFloat", "isNaN", "isFinite",
            "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "Promise.all", "Promise.race", "Promise.resolve", "Promise.reject",
        ]);

        if (SKIP_CALLS.has(text)) return;

        // get the base call name:
        // foo()           → "foo"
        // utils.foo()     → "foo"
        // this.foo()      → "foo"
        // obj.a.b.foo()   → "foo"
        const parts = text.split(".");
        const baseName = parts[parts.length - 1];

        // skip if it looks like a constructor or built-in
        if (!baseName || /^[A-Z]/.test(baseName)) return;

        calls.add(baseName);
    });

    return [...calls];
}

// ── Function extractors ──────────────────────────────────────────────────────

function determineFunctionKind(
    node: Node,
    name: string,
    defaultKind: FunctionKind
): FunctionKind {
    // Priority 1: constructor
    if (node.getKind() === SyntaxKind.Constructor) return "constructor";

    // Priority 2: getter
    if (node.getKind() === SyntaxKind.GetAccessor) return "getter";

    // Priority 3: setter
    if (node.getKind() === SyntaxKind.SetAccessor) return "setter";

    // Priority 4: test — generalized across all test frameworks via TEST_CALL_PATTERN
    // Names look like: "describe(TagFolder childFolders)", "it(should throw...)", etc.
    // The regex matches the opening call name before the first "("
    if (/^[xf]?(it|test|describe|suite|context|specify)\(/.test(name) ||
        /^(before|after)(Each|All)?\(/.test(name)) {
        return "test";
    }

    // Priority 5: route-handler
    // check if it's an argument to a route registration call
    const parent = node.getParent();
    if (parent && parent.getKind() === SyntaxKind.CallExpression) {
        const callExpr = parent as any;
        const callee = callExpr.getExpression?.();
        if (callee && callee.getKind() === SyntaxKind.PropertyAccessExpression) {
            const propAccess = callee as any;
            const objText = propAccess.Expression?.getText() || propAccess.getExpression?.()?.getText() || "";
            const methodText = propAccess.Name?.getText() || propAccess.getName?.() || "";
            if (/^(app|router|server|api|route)$/i.test(objText) && /^(get|post|put|delete|patch|use|all)$/i.test(methodText)) {
                return "route-handler";
            }
        }
    }

    // Priority 6: middleware
    let params: any[] = [];
    if (
        Node.isFunctionDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        Node.isMethodDeclaration(node)
    ) {
        params = node.getParameters();
    }

    if (params.length === 3) {
        const p1 = params[0].getName();
        const p2 = params[1].getName();
        const p3 = params[2].getName();
        if (/^(req|request|ctx|context)$/i.test(p1) && /^(res|response)$/i.test(p2) && /^next$/i.test(p3)) {
            return "middleware";
        }
    } else if (params.length === 2) {
        const p1 = params[0].getName();
        const p2 = params[1].getName();
        if (/^(ctx|context)$/i.test(p1) && /^next$/i.test(p2)) {
            return "middleware";
        }
    }

    // Priority 7: async
    let isNodeAsync = false;
    if ((node as any).isAsync) {
        isNodeAsync = (node as any).isAsync();
    } else if ((node as any).hasModifier) {
        isNodeAsync = (node as any).hasModifier(SyntaxKind.AsyncKeyword);
    }
    if (isNodeAsync) return "async";

    if (defaultKind === "method") return "method";
    if (defaultKind === "arrow") return "arrow";
    if (defaultKind === "function") return "function";
    return defaultKind;
}

function extractFromFunctionDeclaration(
    node: FunctionDeclaration,
    relativePath: string
): FunctionNode | null {
    const name = node.getName();
    if (!name) return null;

    const sourceText = node.getText();
    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: node.isExported(),
        kind: determineFunctionKind(node, name, node.isAsync() ? "async" : "function"),
        isAsync: node.isAsync(),
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function extractFromArrowOrExpression(
    node: ArrowFunction | FunctionExpression,
    relativePath: string
): FunctionNode | null {
    const parent = node.getParent();

    if (parent) {
        if (Node.isCallExpression(parent)) {
            // For CallExpression parents: only extract test runners and route handlers.
            //
            // We explicitly SKIP functional array callbacks (.map, .filter, .reduce etc.)
            // and generic promise chains (.then, .catch) — these are never useful snippets.
            //
            // Everything else (including framework builders like builder.mutationField)
            // is skipped here but will be captured as a STRUCTURE in extractStructures,
            // which is sufficient to prevent false barrel detection.
            const callExpr = parent as any;
            const exprText = callExpr.getExpression?.()?.getText?.() || "";

            const isTestCall = TEST_CALL_PATTERN.test(exprText);
            const isRouteCall = /\.(get|post|put|delete|patch|head|options|use|all|route|handle)$/i.test(exprText);

            if (!isTestCall && !isRouteCall) {
                return null;
            }
        }

        // PropertyAssignment: ALLOW — we now extract these.
        //
        // This enables function body extraction from patterns like:
        //   { resolve: async (_parent, args, ctx) => { ... } }   ← GraphQL resolvers
        //   { handler: async (req, res) => { ... } }             ← route config objects
        //   { middleware: async (ctx, next) => { ... } }         ← middleware configs
        //   { transform: async (data) => { ... } }               ← data pipeline steps
        //
        // Trivial one-liner non-async callbacks are filtered out below
        // after name resolution to avoid noise like { transform: x => x.id }.
    }

    // Walk up the parent chain to find a name for this function.
    let name: string | undefined;
    let current: Node | undefined = node.getParent();

    while (current) {
        const kind = current.getKind();

        // const foo = () => {}
        if (kind === SyntaxKind.VariableDeclaration) {
            const varName = (current as any).getName?.();
            if (typeof varName === "string") name = varName;
            break;
        }

        // { foo: () => {} } inside object literal
        if (kind === SyntaxKind.PropertyAssignment) {
            const propName = (current as any).getName?.();
            if (typeof propName === "string") name = propName;
            break;
        }

        // exports.foo = () => {} or module.exports.foo = () => {}
        if (kind === SyntaxKind.BinaryExpression) {
            const leftText = (current as any).getLeft?.()?.getText?.() ?? "";
            const match = leftText.match(/^(?:module\.)?exports\.([\w$]+)$/);
            if (match) {
                name = match[1];
                break;
            }
        }

        // Passed as argument to a CallExpression
        // (e.g., describe("foo", () => {}), it("bar", async () => {}))
        if (kind === SyntaxKind.CallExpression) {
            const callExpr = current as any;
            const exprText = callExpr.getExpression?.()?.getText?.();
            if (exprText && TEST_CALL_PATTERN.test(exprText)) {
                const args = callExpr.getArguments?.();
                if (args && args.length > 0) {
                    const firstArg = args[0].getText().replace(/['"`]/g, "");
                    name = `${exprText}(${firstArg})`;
                } else {
                    name = `${exprText}()`;
                }
            }
            break;
        }

        // Stop at function/block boundaries
        if (
            kind === SyntaxKind.FunctionDeclaration ||
            kind === SyntaxKind.ArrowFunction ||
            kind === SyntaxKind.FunctionExpression ||
            kind === SyntaxKind.MethodDeclaration ||
            kind === SyntaxKind.SourceFile
        ) {
            break;
        }

        current = current.getParent();
    }

    if (!name) return null;

    // Filter out trivial PropertyAssignment callbacks.
    //
    // When parent is a PropertyAssignment (e.g., { transform: x => x.id }),
    // skip if the function is single-line AND synchronous.
    // Single-line async functions ARE kept because they may contain meaningful
    // DB or auth logic: { resolve: async (p, a, ctx) => ctx.db.users.findFirst() }
    if (parent && Node.isPropertyAssignment(parent)) {
        const lineCount = node.getEndLineNumber() - node.getStartLineNumber();
        const isAsyncFn = (node as any).isAsync?.() ?? false;
        if (lineCount < 1 && !isAsyncFn) return null;
    }

    const sourceText = node.getText();
    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: isExported(node),
        kind: determineFunctionKind(node, name, "arrow"),
        isAsync: (node as any).isAsync?.() ?? false,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function getVisibility(node: MethodDeclaration): Visibility {
    if (node.hasModifier(SyntaxKind.PrivateKeyword)) return "private";
    if (node.hasModifier(SyntaxKind.ProtectedKeyword)) return "protected";
    return "public";
}

function extractFromMethod(
    node: MethodDeclaration,
    relativePath: string
): FunctionNode | null {
    const name = node.getName();
    if (!name) return null;

    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const fullName = className ? `${className}.${name}` : name;

    const sourceText = node.getText();
    return {
        id: makeFunctionId(relativePath, fullName),
        name: fullName,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: isExported(node),
        kind: determineFunctionKind(node, fullName, "method"),
        isAsync: node.isAsync(),
        visibility: getVisibility(node),
        parentId: className ? `${relativePath}::${className}` : undefined,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function extractFromAccessor(
    node: Node,
    relativePath: string,
    accessorKind: "getter" | "setter"
): FunctionNode | null {
    const nameNode = (node as any).getNameNode?.();
    const name = nameNode ? nameNode.getText() : "unknown";

    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const fullName = className ? `${className}.${name}` : name;

    let exported = false;
    if (classDecl) {
        exported = isExported(classDecl);
    }

    const sourceText = node.getText();
    return {
        id: makeFunctionId(relativePath, fullName),
        name: fullName,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: exported,
        kind: accessorKind,
        isAsync: false,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

function extractFromConstructor(
    node: Node,
    relativePath: string
): FunctionNode | null {
    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const name = className ? `${className}.constructor` : "constructor";

    let exported = false;
    if (classDecl) {
        exported = isExported(classDecl);
    }

    let vis: Visibility = "public";
    if ((node as any).hasModifier) {
        if ((node as any).hasModifier(SyntaxKind.PrivateKeyword)) vis = "private";
        else if ((node as any).hasModifier(SyntaxKind.ProtectedKeyword)) vis = "protected";
    }

    const sourceText = node.getText();
    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: exported,
        kind: "constructor",
        isAsync: false,
        visibility: vis,
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
    };
}

// ── CommonJS exports extractor ───────────────────────────────────────────────

const EXPORTS_LEFT_RE = /^(?:module\.)?exports(?:\.([\w$]+))?$/;

function extractFromCommonJS(
    sourceFile: SourceFile,
    relativePath: string
): FunctionNode[] {
    const results: FunctionNode[] = [];

    sourceFile
        .getDescendantsOfKind(SyntaxKind.BinaryExpression)
        .forEach((binExpr) => {
            if (binExpr.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;

            const leftText = binExpr.getLeft().getText().trim();
            const match = leftText.match(EXPORTS_LEFT_RE);
            if (!match) return;

            const right = binExpr.getRight();
            const rightKind = right.getKind();

            if (
                rightKind === SyntaxKind.FunctionExpression ||
                rightKind === SyntaxKind.ArrowFunction
            ) {
                let name: string | undefined;
                if (rightKind === SyntaxKind.FunctionExpression) {
                    name = (right as FunctionExpression).getName();
                }
                if (!name) name = match[1];
                if (!name) return;

                const sourceText = right.getText();
                results.push({
                    id: makeFunctionId(relativePath, name),
                    name,
                    filePath: relativePath,
                    startLine: right.getStartLineNumber(),
                    endLine: right.getEndLineNumber(),
                    isExported: true,
                    kind: determineFunctionKind(right, name, rightKind === SyntaxKind.ArrowFunction ? "arrow" : "function"),
                    isAsync: (right as FunctionExpression | ArrowFunction).isAsync(),
                    calls: extractCallNames(right),
                    calledBy: [],
                    analysisConfidence: "high",
                });
                return;
            }

            if (rightKind === SyntaxKind.ObjectLiteralExpression) {
                right.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((prop) => {
                    const propName = prop.getName();
                    if (!propName) return;

                    const init = prop.getInitializer();
                    if (!init) return;
                    const initKind = init.getKind();

                    if (
                        initKind === SyntaxKind.FunctionExpression ||
                        initKind === SyntaxKind.ArrowFunction
                    ) {
                        const sourceText = init.getText();
                        results.push({
                            id: makeFunctionId(relativePath, propName),
                            name: propName,
                            filePath: relativePath,
                            startLine: init.getStartLineNumber(),
                            endLine: init.getEndLineNumber(),
                            isExported: true,
                            kind: determineFunctionKind(init, propName, initKind === SyntaxKind.ArrowFunction ? "arrow" : "function"),
                            isAsync: (init as FunctionExpression | ArrowFunction).isAsync(),
                            calls: extractCallNames(init),
                            calledBy: [],
                            analysisConfidence: "high",
                        });
                    }
                });
            }
        });

    return results;
}

// ── Structure extractor ──────────────────────────────────────────────────────

function extractStructures(
    sourceFile: SourceFile,
    relativePath: string
): StructureNode[] {
    const structures: StructureNode[] = [];

    // ── Part 1: Exported variable declarations with call initializers ─────────
    //
    // Catches patterns like:
    //   export const mutationSchema = z.object({...})
    //   export const MutationUpdateUserPasswordInput = builder.inputRef(...)
    //   export const router = express.Router()
    //
    // These are already detected in the existing code. They count as structures
    // because they define named, exported values that may be used elsewhere.

    sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).forEach(varDecl => {
        const varStatement = varDecl.getFirstAncestorByKind(SyntaxKind.VariableStatement);
        const isExp = varStatement ? isExported(varStatement) : false;
        if (!isExp) return;

        const initializer = varDecl.getInitializer();
        if (!initializer || initializer.getKind() !== SyntaxKind.CallExpression) return;

        const name = varDecl.getName();
        if (!name) return;

        structures.push({
            id: makeFunctionId(relativePath, name),
            name,
            filePath: relativePath,
            startLine: varDecl.getStartLineNumber(),
            endLine: varDecl.getEndLineNumber(),
            isExported: true,
        });
    });

    // ── Part 2: Top-level ExpressionStatement → CallExpression ───────────────
    //
    // THE CRITICAL FIX: catches side-effectful registration patterns that are
    // NOT exported variable declarations but still define the file's behavior.
    //
    // Examples across frameworks (ALL generalized — no hardcoding):
    //   Pothos GraphQL:  builder.mutationField("updatePassword", ...)
    //   Pothos GraphQL:  builder.queryField("users", ...)
    //   Express:         app.use("/api", router)
    //   Express:         router.get("/health", handler)
    //   Mongoose:        schema.plugin(mongoosePaginate)
    //   NestJS:          NestFactory.create(AppModule)
    //   InversifyJS:     container.bind(UserService).toSelf()
    //   EventEmitter:    emitter.on("data", handler)
    //   Any framework:   someRegistry.register("name", implementation)
    //
    // Without this, these files show 0 functions + 0 structures → false barrel.
    // With this, they get at least 1 structure → never barrel-dropped.

    sourceFile.getStatements().forEach(stmt => {
        // Only ExpressionStatement at the top level
        if (stmt.getKind() !== SyntaxKind.ExpressionStatement) return;

        const expr = (stmt as any).getExpression?.();
        if (!expr || expr.getKind() !== SyntaxKind.CallExpression) return;

        const calleeText = (expr as any).getExpression?.()?.getText?.() || "";
        if (!calleeText || calleeText.length > 150) return;

        // Build a readable name:
        //   builder.mutationField("adminUpdateUserPassword", ...) → "mutationField(adminUpdateUserPassword)"
        //   app.use("/api/v1", router)                           → "app.use"
        //   schema.plugin(mongoosePaginate)                      → "schema.plugin"
        const args = (expr as any).getArguments?.() as Node[] ?? [];
        let name: string;

        const methodPart = calleeText.split(".").pop() || calleeText;

        if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
            // First arg is a string literal → use it as the label
            const firstArgVal = args[0].getText().replace(/^["'`]|["'`]$/g, "");
            name = firstArgVal ? `${methodPart}(${firstArgVal})` : calleeText;
        } else {
            name = calleeText;
        }

        structures.push({
            id: makeFunctionId(relativePath, name),
            name,
            filePath: relativePath,
            startLine: stmt.getStartLineNumber(),
            endLine: stmt.getEndLineNumber(),
            isExported: false,
        });
    });

    // ── Part 3: Exported interfaces & type aliases (TypeScript contracts) ──────
    //
    // Type-only declarations are erased at runtime but are a large part of a
    // TS file's structure (tRPC-style libraries are very type-heavy). Without
    // this, files that only export types/interfaces show as near-empty.
    // Exported-only — matches the public-surface focus of Parts 1-2 and avoids
    // internal one-liner-type noise.
    sourceFile.getInterfaces().forEach(node => {
        if (!node.isExported()) return;
        structures.push({
            id: makeFunctionId(relativePath, node.getName()),
            name: node.getName(),
            filePath: relativePath,
            startLine: node.getStartLineNumber(),
            endLine: node.getEndLineNumber(),
            isExported: true,
            kind: "interface",
        });
    });

    sourceFile.getTypeAliases().forEach(node => {
        if (!node.isExported()) return;
        structures.push({
            id: makeFunctionId(relativePath, node.getName()),
            name: node.getName(),
            filePath: relativePath,
            startLine: node.getStartLineNumber(),
            endLine: node.getEndLineNumber(),
            isExported: true,
            kind: "type",
        });
    });

    return structures;
}

// ── Main extractor ───────────────────────────────────────────────────────────

export function extractFunctionLevel(
    sourceFile: SourceFile,
    relativePath: string
): { functions: FunctionNode[], structures: StructureNode[] } {
    const functions: FunctionNode[] = [];
    const seenIds = new Set<string>();

    function addIfUnique(fn: FunctionNode | null): void {
        if (!fn) return;
        if (seenIds.has(fn.id)) return;
        seenIds.add(fn.id);
        functions.push(fn);
    }

    // 1. Regular function declarations
    sourceFile
        .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
        .forEach((node) => {
            addIfUnique(extractFromFunctionDeclaration(node, relativePath));
        });

    // 2. Arrow functions
    sourceFile
        .getDescendantsOfKind(SyntaxKind.ArrowFunction)
        .forEach((node) => {
            addIfUnique(extractFromArrowOrExpression(node, relativePath));
        });

    // 3. Function expressions: const foo = function() {}
    sourceFile
        .getDescendantsOfKind(SyntaxKind.FunctionExpression)
        .forEach((node) => {
            addIfUnique(extractFromArrowOrExpression(node, relativePath));
        });

    // 4. Class methods
    sourceFile
        .getDescendantsOfKind(SyntaxKind.MethodDeclaration)
        .forEach((node) => {
            addIfUnique(extractFromMethod(node, relativePath));
        });

    // 5. CommonJS: module.exports / exports.foo patterns
    extractFromCommonJS(sourceFile, relativePath).forEach((fn) => {
        addIfUnique(fn);
    });

    // 6. Getters
    sourceFile
        .getDescendantsOfKind(SyntaxKind.GetAccessor)
        .forEach(node => addIfUnique(
            extractFromAccessor(node, relativePath, "getter")
        ));

    // 7. Setters
    sourceFile
        .getDescendantsOfKind(SyntaxKind.SetAccessor)
        .forEach(node => addIfUnique(
            extractFromAccessor(node, relativePath, "setter")
        ));

    // 8. Constructors
    sourceFile
        .getDescendantsOfKind(SyntaxKind.Constructor)
        .forEach(node => addIfUnique(
            extractFromConstructor(node, relativePath)
        ));

    return { functions, structures: extractStructures(sourceFile, relativePath) };
}

// ── Test metadata extractor ──────────────────────────────────────────────────
//
// Extracts test suite and case names for the UI's "Test Intelligence" panel.
// Uses TEST_CALL_PATTERN for generalized framework coverage — works with Jest,
// Vitest, Mocha, Jasmine, node:test, and any framework using the same keywords.

export function extractTestMetadata(
    sourceFile: SourceFile
): { testSuites: string[]; testCases: string[] } {
    const testSuites: string[] = [];
    const testCases: string[] = [];

    sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach((callExpr) => {
        const callee = callExpr.getExpression().getText().trim();
        const args = callExpr.getArguments();

        if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
            const argText = args[0].getText().replace(/^["'`]|["'`]$/g, "");

            // Suite-level: describe, suite, context (and their x/f prefixed variants)
            if (/^[xf]?(describe|suite|context)$/.test(callee)) {
                testSuites.push(argText);
            }
            // Case-level: it, test, specify (and their x/f prefixed variants)
            else if (/^[xf]?(it|test|specify)$/.test(callee)) {
                testCases.push(argText);
            }
        }
    });

    return { testSuites, testCases };
}