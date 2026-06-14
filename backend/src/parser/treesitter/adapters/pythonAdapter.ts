// src/parser/treesitter/adapters/pythonAdapter.ts
// ─────────────────────────────────────────────────────────────────────────────
// Python adapter — extracts imports, functions, classes, calls from the
// tree-sitter-python AST.
//
// Grammar nodes handled:
//   import_statement        import a.b.c / import a.b as x  (aliased_import)
//   import_from_statement   from X import a, b / from . import y / from .. import z
//                           (relative_import = import_prefix dots + dotted_name)
//   wildcard_import         from x import *
//   function_definition     incl. async, decorators (decorated_definition wrapper)
//   class_definition        → StructureNode + methods get parentId + "Class.method" name
//   call                    function field: identifier | attribute
//   __main__ guard          if __name__ == "__main__": → startup signal
// ─────────────────────────────────────────────────────────────────────────────

import type { Node as TSNode } from "web-tree-sitter";
import { Language, FileKind, StructureNode } from "../../../models/graph";
import { LanguageAdapter, ExtractResult, LangRawImport } from "../types";
import { walk, FunctionCollector, extractCallNames, inTestDir, nearestEnclosing, sweepFunctionsOnError } from "./util";

function calleeName(callee: TSNode): string | null {
    if (callee.type === "identifier") return callee.text;
    if (callee.type === "attribute") {
        const attr = callee.childForFieldName("attribute");
        return attr ? attr.text : null;
    }
    // fallback: last dotted segment
    const text = callee.text;
    if (text.length > 0 && text.length < 200) return text.split(".").pop() ?? null;
    return null;
}

export class PythonAdapter implements LanguageAdapter {
    languageId: Language = "python" as Language;
    extensions = [".py"];
    wasmName = "python";

    detectFileKind(relativePath: string): FileKind {
        const base = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
        if (
            base.startsWith("test_") || base.endsWith("_test.py") ||
            base === "conftest.py" || inTestDir(relativePath)
        ) return "test";
        if (base === "setup.py" || base === "conf.py" || base === "settings.py") return "config";
        return "source";
    }

    extract(rootNode: TSNode, content: string, relativePath: string): ExtractResult {
        const rawImports: LangRawImport[] = [];
        const structures: StructureNode[] = [];
        const collector = new FunctionCollector(relativePath);
        const testSuites: string[] = [];
        const testCases: string[] = [];
        let hasStartupSignals = false;

        const isTestFile = this.detectFileKind(relativePath) === "test";

        const handleFunction = (node: TSNode, parentClass: { id: string; name: string } | null) => {
            const nameNode = node.childForFieldName("name");
            if (!nameNode) return;
            const bareName = nameNode.text;
            const name = parentClass ? `${parentClass.name}.${bareName}` : bareName;

            const isAsync = node.children.some((c: TSNode | null) => c?.type === "async") ||
                            node.firstChild?.type === "async" ||
                            /^\s*async\s/.test(node.text.slice(0, 12));

            const isTestFn = isTestFile && bareName.startsWith("test");
            if (isTestFn) testCases.push(bareName);

            const calls = extractCallNames(node, "call", "function", calleeName);

            collector.add({
                name,
                startLine: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                // Python convention: no underscore prefix = public; dunders are special but public
                isExported: !bareName.startsWith("_") || (bareName.startsWith("__") && bareName.endsWith("__")),
                isAsync,
                kind: isTestFn ? "test" : parentClass ? "method" : "function",
                calls,
                parentId: parentClass?.id,
            });
        };

        const visit = (node: TSNode, parentClass: { id: string; name: string } | null) => {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (!child) continue;

                switch (child.type) {
                    case "import_statement": {
                        // import a.b.c [as x][, d.e [as y]]
                        for (let j = 0; j < child.namedChildCount; j++) {
                            const item = child.namedChild(j);
                            if (!item) continue;
                            const dotted = item.type === "aliased_import"
                                ? item.childForFieldName("name")?.text
                                : item.type === "dotted_name" ? item.text : null;
                            if (dotted) {
                                rawImports.push({
                                    specifier: dotted,
                                    symbols: [],
                                    kind: "static",
                                    meta: { relativeDots: 0, isFromImport: false },
                                });
                            }
                        }
                        break;
                    }

                    case "import_from_statement": {
                        // from <module_name> import <names...>
                        const moduleNode = child.childForFieldName("module_name");
                        let dots = 0;
                        let dotted = "";
                        if (moduleNode) {
                            if (moduleNode.type === "relative_import") {
                                // import_prefix (dots) + optional dotted_name
                                for (let j = 0; j < moduleNode.childCount; j++) {
                                    const part = moduleNode.child(j);
                                    if (!part) continue;
                                    if (part.type === "import_prefix") dots = part.text.length;
                                    if (part.type === "dotted_name") dotted = part.text;
                                }
                            } else if (moduleNode.type === "dotted_name") {
                                dotted = moduleNode.text;
                            }
                        }

                        const symbols: string[] = [];
                        let isWildcard = false;
                        for (let j = 0; j < child.namedChildCount; j++) {
                            const item = child.namedChild(j);
                            if (!item || item === moduleNode) continue;
                            if (item.type === "dotted_name") symbols.push(item.text);
                            else if (item.type === "aliased_import") {
                                const n = item.childForFieldName("name");
                                if (n) symbols.push(n.text);
                            } else if (item.type === "wildcard_import") {
                                isWildcard = true;
                            }
                        }
                        if (isWildcard) symbols.push("*");

                        rawImports.push({
                            specifier: dotted,
                            symbols,
                            kind: isWildcard ? "re-export" : "static",
                            meta: { relativeDots: dots, isFromImport: true },
                        });
                        break;
                    }

                    case "decorated_definition": {
                        // unwrap decorators → the inner def/class
                        const inner = child.childForFieldName("definition");
                        if (inner?.type === "function_definition") handleFunction(inner, parentClass);
                        else if (inner?.type === "class_definition") visitClass(inner);
                        break;
                    }

                    case "function_definition":
                        handleFunction(child, parentClass);
                        break;

                    case "class_definition":
                        visitClass(child);
                        break;

                    case "if_statement": {
                        // if __name__ == "__main__": → entry point signal
                        const cond = child.childForFieldName("condition");
                        if (cond && cond.text.includes("__name__") && cond.text.includes("__main__")) {
                            hasStartupSignals = true;
                            // still visit body — may call main()
                        }
                        visit(child, parentClass);
                        break;
                    }

                    default:
                        // descend into blocks (try/except imports, conditional imports, etc.)
                        if (child.namedChildCount > 0) visit(child, parentClass);
                }
            }
        };

        const visitClass = (classNode: TSNode) => {
            const nameNode = classNode.childForFieldName("name");
            const className = nameNode ? nameNode.text : "AnonymousClass";
            const classId = `${relativePath}::${className}`;

            structures.push({
                id: classId,
                name: className,
                filePath: relativePath,
                startLine: classNode.startPosition.row + 1,
                endLine: classNode.endPosition.row + 1,
                isExported: !className.startsWith("_"),
            });

            if (isTestFile && className.startsWith("Test")) testSuites.push(className);

            const body = classNode.childForFieldName("body");
            if (body) visit(body, { id: classId, name: className });
        };

        visit(rootNode, null);

        // ERROR-tolerant fallback: if a malformed parse left the structured pass
        // empty, sweep the whole tree so functions aren't silently dropped.
        if (collector.functions.length === 0 && rootNode.hasError) {
            sweepFunctionsOnError(rootNode, new Set(["function_definition"]), (n) => {
                const clsNode = nearestEnclosing(n, new Set(["class_definition"]));
                const cn = clsNode?.childForFieldName("name")?.text;
                const parentClass = cn ? { id: `${relativePath}::${cn}`, name: cn } : null;
                handleFunction(n, parentClass);
            });
        }

        // module-level startup heuristics beyond __main__ guard
        if (!hasStartupSignals) {
            const head = content.slice(0, 4000);
            if (/\bapp\.run\(|\buvicorn\.run\(|\bApplication\(\)|\bcli\(\)/.test(head)) {
                hasStartupSignals = true;
            }
        }

        return {
            functions: collector.functions,
            structures,
            rawImports,
            testSuites,
            testCases,
            hasStartupSignals,
        };
    }
}
