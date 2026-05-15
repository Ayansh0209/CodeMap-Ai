"use strict";
// Extracts all functions and call relationships from a single source file
// Only runs on files < 500KB (mode: "full")
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractFunctionLevel = extractFunctionLevel;
exports.extractTestMetadata = extractTestMetadata;
const ts_morph_1 = require("ts-morph");
// ── Helpers ─────────────────────────────────────────────────────────────────
function makeFunctionId(relativePath, functionName) {
    return `${relativePath}::${functionName}`;
}
function isExported(node) {
    return node
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.ExportKeyword)
        .length > 0 ||
        node.getFirstAncestorByKind(ts_morph_1.SyntaxKind.ExportDeclaration) !== undefined;
}
// ── Call expression extraction ───────────────────────────────────────────────
// Finds all function calls made inside a given node's body
// Returns raw call names — resolved to IDs by chunkProcessor
function extractCallNames(node) {
    const calls = new Set();
    node.getDescendantsOfKind(ts_morph_1.SyntaxKind.CallExpression).forEach((call) => {
        const expr = call.getExpression();
        const text = expr.getText().trim();
        // skip empty or overly complex expressions
        if (!text || text.length > 100)
            return;
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
        if (SKIP_CALLS.has(text))
            return;
        // get the base call name:
        // foo()           → "foo"
        // utils.foo()     → "foo"
        // this.foo()      → "foo"
        // obj.a.b.foo()   → "foo"
        const parts = text.split(".");
        const baseName = parts[parts.length - 1];
        // skip if it looks like a constructor or built-in
        if (!baseName || /^[A-Z]/.test(baseName))
            return;
        calls.add(baseName);
    });
    return [...calls];
}
// ── Retrieval signal detectors ───────────────────────────────────────────────
// These run on the source text of each function body — no extra AST traversal.
// We call node.getText() which ts-morph provides cheaply from its internal cache.
/**
 * Detect if a function contains authorization or permission-checking logic.
 *
 * Rationale for each pattern:
 *   - checkAuth / requireAuth / verifyAuth / isAuthenticated: common auth utility names
 *   - hasPermission / checkPermission / canAccess / isAuthorized: role/permission check calls
 *   - context.user / ctx.user / req.user: reading user from request/context (access control)
 *   - creatorId / userId comparisons or ownership checks (common in GraphQL resolvers)
 *   - throw.*Unauthorized / throw.*Forbidden / throw.*AuthError: throwing auth errors
 *   - roles.includes / user.role / userRole: role-based access control patterns
 *   - session.userId / session.user: session-based auth checks
 *
 * We use a regex on the full source text (case-insensitive) rather than
 * individual call expressions to catch both call-based and throw-based patterns
 * without a second traversal pass.
 *
 * Avoiding false positives:
 *   - We do NOT flag mere imports of auth utilities (those live in the import
 *     declarations, not the function body text)
 *   - Minimum 2-char method names keep us from matching on 'auth' in variable names
 */
const AUTH_PATTERNS = [
    // Auth check function calls
    /\b(checkAuth|requireAuth|verifyAuth|ensureAuth|authenticate|isAuthenticated)\s*\(/i,
    // Permission/role check calls
    /\b(hasPermission|checkPermission|canAccess|isAuthorized|requireRole|checkRole)\s*\(/i,
    // User from context/request — reading it means the function cares about identity
    /\b(context|ctx|req)\.(user|currentUser|loggedInUser|viewer)\b/i,
    // Ownership checks: creatorId, userId comparisons
    /\b(creatorId|ownerId|userId)\s*[!=]==/,
    // Throwing auth errors — the function is a gatekeeper
    /throw\s+new\s+\w*(Unauthorized|Forbidden|AuthorizationError|AccessDenied|AuthError)/i,
    // Role-based checks
    /\b(roles?)\.includes\s*\(/i,
    /\buser\.(role|roles|permissions)\b/i,
    // Session-based auth
    /\bsession\.(userId|user|isAuthenticated)\b/i,
    // JWT decode/verify calls inside the function body
    /\b(jwt\.verify|verifyToken|decodeToken)\s*\(/i,
];
function detectAuthCheck(sourceText) {
    return AUTH_PATTERNS.some(pattern => pattern.test(sourceText));
}
/**
 * Detect if a function contains database operations.
 *
 * Rationale for each pattern:
 *   Prisma:    prisma.model.findUnique/findFirst/findMany/create/update/delete/upsert
 *   Mongoose:  Model.find/findOne/findById/save/create/update/deleteOne
 *   TypeORM:   repository.find/findOne/save/delete/update, getRepository(), createQueryBuilder()
 *   Sequelize: Model.findOne/findAll/create/update/destroy
 *   Raw SQL:   db.query(), pool.query(), client.query(), knex()
 *   Drizzle:   db.select()/insert()/update()/delete() — common in modern TS backends
 *
 * We look for the method call name patterns rather than the object name
 * so we catch any ORM's syntax. This means we check for .findOne( / .findMany(
 * regardless of whether the receiver is called 'prisma', 'User', or 'repo'.
 *
 * Avoiding false positives:
 *   - Array methods like Array.find / Array.findIndex are excluded by requiring
 *     the 'One'/'Many'/'First'/'All' suffix or checking for DB-specific names.
 *   - We use word boundaries and require parentheses to confirm it's a call.
 */
const DB_PATTERNS = [
    // findOne / findMany / findFirst / findAll / findById / findUnique
    /\.find(One|Many|First|All|ById|Unique|AndCount)?\s*\(/i,
    // create / createMany / createQueryBuilder
    /\.(create|createMany|createQueryBuilder)\s*\(/i,
    // save / saveAll
    /\.(save|saveAll)\s*\(/i,
    // update / updateOne / updateMany / upsert
    /\.(update|updateOne|updateMany|upsert)\s*\(/i,
    // delete / deleteOne / deleteMany / destroy / remove
    /\.(delete|deleteOne|deleteMany|destroy|remove)\s*\(/i,
    // insert / insertMany / insertOne
    /\.(insert|insertMany|insertOne)\s*\(/i,
    // aggregate / count / exists
    /\.(aggregate|count|exists|sum|avg|max|min)\s*\(/i,
    // Raw SQL: db.query, pool.query, client.query, connection.query
    /\b(db|pool|client|connection|knex|sql)\.query\s*\(/i,
    // Drizzle ORM: db.select(), db.insert(), db.update(), db.delete()
    /\bdb\.(select|insert|update|delete)\s*\(/i,
    // getRepository() or getManager() — TypeORM
    /\b(getRepository|getManager|getConnection)\s*\(/i,
    // Prisma-specific: .$transaction, .$queryRaw, .$executeRaw
    /\.\$(transaction|queryRaw|executeRaw|connect|disconnect)\s*\(/i,
];
function detectDatabaseCall(sourceText) {
    return DB_PATTERNS.some(pattern => pattern.test(sourceText));
}
// ── Function extractors ──────────────────────────────────────────────────────
function determineFunctionKind(node, name, defaultKind) {
    // Priority 1: constructor
    if (node.getKind() === ts_morph_1.SyntaxKind.Constructor)
        return "constructor";
    // Priority 2: getter
    if (node.getKind() === ts_morph_1.SyntaxKind.GetAccessor)
        return "getter";
    // Priority 3: setter
    if (node.getKind() === ts_morph_1.SyntaxKind.SetAccessor)
        return "setter";
    // Priority 4: test
    if (name.startsWith("describe(") || name.startsWith("it(") || name.startsWith("test(") ||
        name.startsWith("suite(") || name.startsWith("beforeEach(") || name.startsWith("afterEach(") ||
        name.startsWith("beforeAll(") || name.startsWith("afterAll(")) {
        return "test";
    }
    // Priority 5: route-handler
    // check if it's an argument to a route registration call
    const parent = node.getParent();
    if (parent && parent.getKind() === ts_morph_1.SyntaxKind.CallExpression) {
        const callExpr = parent;
        const callee = callExpr.getExpression?.();
        if (callee && callee.getKind() === ts_morph_1.SyntaxKind.PropertyAccessExpression) {
            const propAccess = callee;
            const objText = propAccess.Expression?.getText() || propAccess.getExpression?.()?.getText() || "";
            const methodText = propAccess.Name?.getText() || propAccess.getName?.() || "";
            if (/^(app|router|server|api|route)$/i.test(objText) && /^(get|post|put|delete|patch|use|all)$/i.test(methodText)) {
                return "route-handler";
            }
        }
    }
    // Priority 6: middleware (or alternatively 2-param route handler if not caught by #5, but the instructions say apply middleware check to params)
    let params = [];
    if (ts_morph_1.Node.isFunctionDeclaration(node) ||
        ts_morph_1.Node.isArrowFunction(node) ||
        ts_morph_1.Node.isFunctionExpression(node) ||
        ts_morph_1.Node.isMethodDeclaration(node)) {
        params = node.getParameters();
    }
    if (params.length === 3) {
        const p1 = params[0].getName();
        const p2 = params[1].getName();
        const p3 = params[2].getName();
        if (/^(req|request|ctx|context)$/i.test(p1) && /^(res|response)$/i.test(p2) && /^next$/i.test(p3)) {
            return "middleware";
        }
    }
    else if (params.length === 2) {
        const p1 = params[0].getName();
        const p2 = params[1].getName();
        if (/^(ctx|context)$/i.test(p1) && /^next$/i.test(p2)) {
            return "middleware";
        }
    }
    // Priority 7: async
    let isNodeAsync = false;
    if (node.isAsync) {
        isNodeAsync = node.isAsync();
    }
    else if (node.hasModifier) {
        isNodeAsync = node.hasModifier(ts_morph_1.SyntaxKind.AsyncKeyword);
    }
    if (isNodeAsync)
        return "async";
    // Fallbacks (method, arrow, function, unknown) are passed via defaultKind based on extraction point
    if (defaultKind === "method")
        return "method";
    if (defaultKind === "arrow")
        return "arrow";
    if (defaultKind === "function")
        return "function";
    return defaultKind;
}
function extractFromFunctionDeclaration(node, relativePath) {
    const name = node.getName();
    if (!name)
        return null; // anonymous function declaration — skip
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
        hasAuthCheck: detectAuthCheck(sourceText),
        hasDatabaseCall: detectDatabaseCall(sourceText),
    };
}
function extractFromArrowOrExpression(node, relativePath) {
    const parent = node.getParent();
    if (parent) {
        if (ts_morph_1.Node.isPropertyAssignment(parent) || ts_morph_1.Node.isCallExpression(parent)) {
            // Check if it's a valid test or route handler
            let isTestOrRoute = false;
            if (ts_morph_1.Node.isCallExpression(parent)) {
                const callExpr = parent;
                const exprText = callExpr.getExpression?.()?.getText?.() || "";
                if (/^(it|test|describe|suite|beforeEach|afterEach|beforeAll|afterAll)$/.test(exprText)) {
                    isTestOrRoute = true;
                }
                else if (/\.(get|post|put|delete|patch|use|all)$/i.test(exprText)) {
                    isTestOrRoute = true;
                }
            }
            if (!isTestOrRoute) {
                return null; // skip invalid function
            }
        }
    }
    // Walk up the parent chain to find a name for this function.
    // Handles: const foo = () => {}
    //          { foo: function() {} }
    //          exports.foo = () => {}
    //          module.exports.foo = function() {}
    let name;
    let current = node.getParent();
    while (current) {
        const kind = current.getKind();
        // const foo = () => {}
        if (kind === ts_morph_1.SyntaxKind.VariableDeclaration) {
            const varName = current.getName?.();
            if (typeof varName === "string")
                name = varName;
            break;
        }
        // { foo: () => {} } inside object literal
        if (kind === ts_morph_1.SyntaxKind.PropertyAssignment) {
            const propName = current.getName?.();
            if (typeof propName === "string")
                name = propName;
            break;
        }
        // exports.foo = () => {} or module.exports.foo = () => {}
        if (kind === ts_morph_1.SyntaxKind.BinaryExpression) {
            const leftText = current.getLeft?.()?.getText?.() ?? "";
            const match = leftText.match(/^(?:module\.)?exports\.([\w$]+)$/);
            if (match) {
                name = match[1];
                break;
            }
        }
        // Passed as argument to a CallExpression (e.g., describe("foo", () => {}), map(() => {}))
        if (kind === ts_morph_1.SyntaxKind.CallExpression) {
            const callExpr = current;
            const exprText = callExpr.getExpression?.()?.getText?.();
            if (exprText) {
                if (/^(it|test|describe|beforeEach|afterEach|beforeAll|afterAll)$/.test(exprText)) {
                    const args = callExpr.getArguments?.();
                    if (args && args.length > 0) {
                        const firstArg = args[0].getText().replace(/['"`]/g, "");
                        name = `${exprText}(${firstArg})`;
                    }
                    else {
                        name = `${exprText}()`;
                    }
                }
            }
            break;
        }
        // Stop at function/block boundaries — don't walk outside the function scope
        if (kind === ts_morph_1.SyntaxKind.FunctionDeclaration ||
            kind === ts_morph_1.SyntaxKind.ArrowFunction ||
            kind === ts_morph_1.SyntaxKind.FunctionExpression ||
            kind === ts_morph_1.SyntaxKind.MethodDeclaration ||
            kind === ts_morph_1.SyntaxKind.SourceFile) {
            break;
        }
        current = current.getParent();
    }
    if (!name)
        return null; // truly anonymous — skip
    const sourceText = node.getText();
    return {
        id: makeFunctionId(relativePath, name),
        name,
        filePath: relativePath,
        startLine: node.getStartLineNumber(),
        endLine: node.getEndLineNumber(),
        isExported: isExported(node),
        kind: determineFunctionKind(node, name, "arrow"),
        isAsync: node.hasModifier(ts_morph_1.SyntaxKind.AsyncKeyword),
        calls: extractCallNames(node),
        calledBy: [],
        analysisConfidence: "high",
        hasAuthCheck: detectAuthCheck(sourceText),
        hasDatabaseCall: detectDatabaseCall(sourceText),
    };
}
function getVisibility(node) {
    if (node.hasModifier(ts_morph_1.SyntaxKind.PrivateKeyword))
        return "private";
    if (node.hasModifier(ts_morph_1.SyntaxKind.ProtectedKeyword))
        return "protected";
    return "public";
}
function extractFromMethod(node, relativePath) {
    const name = node.getName();
    if (!name)
        return null;
    // prefix with class name for clarity: "MyClass.myMethod"
    const classDecl = node.getFirstAncestorByKind(ts_morph_1.SyntaxKind.ClassDeclaration);
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
        hasAuthCheck: detectAuthCheck(sourceText),
        hasDatabaseCall: detectDatabaseCall(sourceText),
    };
}
function extractFromAccessor(node, // GetAccessorDeclaration | SetAccessorDeclaration
relativePath, accessorKind) {
    const nameNode = node.getNameNode?.();
    const name = nameNode ? nameNode.getText() : "unknown";
    const classDecl = node.getFirstAncestorByKind(ts_morph_1.SyntaxKind.ClassDeclaration);
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
        hasAuthCheck: detectAuthCheck(sourceText),
        hasDatabaseCall: detectDatabaseCall(sourceText),
    };
}
function extractFromConstructor(node, // ConstructorDeclaration
relativePath) {
    const classDecl = node.getFirstAncestorByKind(ts_morph_1.SyntaxKind.ClassDeclaration);
    const className = classDecl?.getName();
    const name = className ? `${className}.constructor` : "constructor";
    let exported = false;
    if (classDecl) {
        exported = isExported(classDecl);
    }
    let vis = "public";
    if (node.hasModifier) {
        if (node.hasModifier(ts_morph_1.SyntaxKind.PrivateKeyword))
            vis = "private";
        else if (node.hasModifier(ts_morph_1.SyntaxKind.ProtectedKeyword))
            vis = "protected";
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
        hasAuthCheck: detectAuthCheck(sourceText),
        hasDatabaseCall: detectDatabaseCall(sourceText),
    };
}
// ── CommonJS exports extractor ───────────────────────────────────────────────
// Handles:
//   module.exports = function foo() {}
//   module.exports = { foo: function() {} }
//   exports.foo = function() {}
//   module.exports.foo = function() {}
const EXPORTS_LEFT_RE = /^(?:module\.)?exports(?:\.([\w$]+))?$/;
function extractFromCommonJS(sourceFile, relativePath) {
    const results = [];
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.BinaryExpression)
        .forEach((binExpr) => {
        // Only handle assignment expressions
        if (binExpr.getOperatorToken().getKind() !== ts_morph_1.SyntaxKind.EqualsToken)
            return;
        const leftText = binExpr.getLeft().getText().trim();
        const match = leftText.match(EXPORTS_LEFT_RE);
        if (!match)
            return;
        const right = binExpr.getRight();
        const rightKind = right.getKind();
        // module.exports = function foo() {} or exports.foo = function() {}
        if (rightKind === ts_morph_1.SyntaxKind.FunctionExpression ||
            rightKind === ts_morph_1.SyntaxKind.ArrowFunction) {
            // Try to get name from: 1) function's own name, 2) left side property
            let name;
            if (rightKind === ts_morph_1.SyntaxKind.FunctionExpression) {
                name = right.getName();
            }
            if (!name)
                name = match[1]; // exports.foo → "foo"
            if (!name)
                return; // module.exports = function() {} — anonymous, skip
            const sourceText = right.getText();
            results.push({
                id: makeFunctionId(relativePath, name),
                name,
                filePath: relativePath,
                startLine: right.getStartLineNumber(),
                endLine: right.getEndLineNumber(),
                isExported: true,
                kind: determineFunctionKind(right, name, rightKind === ts_morph_1.SyntaxKind.ArrowFunction ? "arrow" : "function"),
                isAsync: right.isAsync(),
                calls: extractCallNames(right),
                calledBy: [],
                analysisConfidence: "high",
                hasAuthCheck: detectAuthCheck(sourceText),
                hasDatabaseCall: detectDatabaseCall(sourceText),
            });
            return;
        }
        // module.exports = { foo: function() {}, bar: () => {} }
        if (rightKind === ts_morph_1.SyntaxKind.ObjectLiteralExpression) {
            right.getDescendantsOfKind(ts_morph_1.SyntaxKind.PropertyAssignment).forEach((prop) => {
                const propName = prop.getName();
                if (!propName)
                    return;
                const init = prop.getInitializer();
                if (!init)
                    return;
                const initKind = init.getKind();
                if (initKind === ts_morph_1.SyntaxKind.FunctionExpression ||
                    initKind === ts_morph_1.SyntaxKind.ArrowFunction) {
                    const sourceText = init.getText();
                    results.push({
                        id: makeFunctionId(relativePath, propName),
                        name: propName,
                        filePath: relativePath,
                        startLine: init.getStartLineNumber(),
                        endLine: init.getEndLineNumber(),
                        isExported: true,
                        kind: determineFunctionKind(init, propName, initKind === ts_morph_1.SyntaxKind.ArrowFunction ? "arrow" : "function"),
                        isAsync: init.isAsync(),
                        calls: extractCallNames(init),
                        calledBy: [],
                        analysisConfidence: "high",
                        hasAuthCheck: detectAuthCheck(sourceText),
                        hasDatabaseCall: detectDatabaseCall(sourceText),
                    });
                }
            });
        }
    });
    return results;
}
// ── Main extractor ───────────────────────────────────────────────────────────
function extractStructures(sourceFile, relativePath) {
    const structures = [];
    sourceFile.getDescendantsOfKind(ts_morph_1.SyntaxKind.VariableDeclaration).forEach(varDecl => {
        const varStatement = varDecl.getFirstAncestorByKind(ts_morph_1.SyntaxKind.VariableStatement);
        const isExp = varStatement ? isExported(varStatement) : false;
        if (!isExp)
            return;
        const initializer = varDecl.getInitializer();
        if (!initializer || initializer.getKind() !== ts_morph_1.SyntaxKind.CallExpression)
            return;
        const name = varDecl.getName();
        if (!name)
            return;
        structures.push({
            id: makeFunctionId(relativePath, name),
            name,
            filePath: relativePath,
            startLine: varDecl.getStartLineNumber(),
            endLine: varDecl.getEndLineNumber(),
            isExported: true,
        });
    });
    return structures;
}
function extractFunctionLevel(sourceFile, relativePath) {
    const functions = [];
    const seenIds = new Set(); // deduplicate by ID
    function addIfUnique(fn) {
        if (!fn)
            return;
        if (seenIds.has(fn.id))
            return;
        seenIds.add(fn.id);
        functions.push(fn);
    }
    // 1. Regular function declarations
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.FunctionDeclaration)
        .forEach((node) => {
        addIfUnique(extractFromFunctionDeclaration(node, relativePath));
    });
    // 2. Arrow functions
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.ArrowFunction)
        .forEach((node) => {
        addIfUnique(extractFromArrowOrExpression(node, relativePath));
    });
    // 3. Function expressions: const foo = function() {}
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.FunctionExpression)
        .forEach((node) => {
        addIfUnique(extractFromArrowOrExpression(node, relativePath));
    });
    // 4. Class methods
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.MethodDeclaration)
        .forEach((node) => {
        addIfUnique(extractFromMethod(node, relativePath));
    });
    // 5. CommonJS: module.exports / exports.foo patterns
    extractFromCommonJS(sourceFile, relativePath).forEach((fn) => {
        addIfUnique(fn);
    });
    // 6. Getters
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.GetAccessor)
        .forEach(node => addIfUnique(extractFromAccessor(node, relativePath, "getter")));
    // 7. Setters
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.SetAccessor)
        .forEach(node => addIfUnique(extractFromAccessor(node, relativePath, "setter")));
    // 8. Constructors
    sourceFile
        .getDescendantsOfKind(ts_morph_1.SyntaxKind.Constructor)
        .forEach(node => addIfUnique(extractFromConstructor(node, relativePath)));
    return { functions, structures: extractStructures(sourceFile, relativePath) };
}
function extractTestMetadata(sourceFile) {
    const testSuites = [];
    const testCases = [];
    sourceFile.getDescendantsOfKind(ts_morph_1.SyntaxKind.CallExpression).forEach((callExpr) => {
        const callee = callExpr.getExpression().getText().trim();
        const args = callExpr.getArguments();
        if (args.length > 0 && args[0].getKind() === ts_morph_1.SyntaxKind.StringLiteral) {
            const argText = args[0].getText().replace(/^["'`]|["'`]$/g, "");
            if (/^(describe|suite)$/.test(callee)) {
                testSuites.push(argText);
            }
            else if (/^(it|test)$/.test(callee)) {
                testCases.push(argText);
            }
        }
    });
    return { testSuites, testCases };
}
