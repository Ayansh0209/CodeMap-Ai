// src/parser/treesitter/adapters/goAdapter.ts
// ─────────────────────────────────────────────────────────────────────────────
// Go adapter — extracts imports, functions, methods, types, calls from the
// tree-sitter-go AST.
//
// Grammar nodes handled:
//   import_declaration → import_spec (path field; name = alias | . | _)
//   function_declaration              func Foo() {}
//   method_declaration                func (r *Recv) Foo() {} → "Recv.Foo"
//   type_declaration → type_spec      structs/interfaces → StructureNode
//   call_expression                   identifier | selector_expression
//   package main + func main          → startup signal
//   *_test.go / func TestXxx          → test detection
// ─────────────────────────────────────────────────────────────────────────────

import type { Node as TSNode } from "web-tree-sitter";
import { Language, FileKind, StructureNode } from "../../../models/graph";
import { LanguageAdapter, ExtractResult, LangRawImport } from "../types";
import { FunctionCollector, extractCallNames, inTestDir, sweepFunctionsOnError } from "./util";

function calleeName(callee: TSNode): string | null {
    if (callee.type === "identifier") return callee.text;
    if (callee.type === "selector_expression") {
        const field = callee.childForFieldName("field");
        return field ? field.text : null;
    }
    if (callee.type === "parenthesized_expression") {
        const inner = callee.namedChild(0);
        return inner ? calleeName(inner) : null;
    }
    return null;
}

function isExportedGo(name: string): boolean {
    return /^[A-Z]/.test(name);
}

/** receiver "(r *MyType)" / "(r MyType)" → "MyType" */
function receiverTypeName(receiver: TSNode): string | null {
    let typeName: string | null = null;
    const visit = (n: TSNode) => {
        if (n.type === "type_identifier") typeName = n.text;
        for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c) visit(c);
        }
    };
    visit(receiver);
    return typeName;
}

export class GoAdapter implements LanguageAdapter {
    languageId: Language = "go" as Language;
    extensions = [".go"];
    wasmName = "go";

    detectFileKind(relativePath: string): FileKind {
        if (relativePath.endsWith("_test.go") || inTestDir(relativePath)) return "test";
        return "source";
    }

    extract(rootNode: TSNode, content: string, relativePath: string): ExtractResult {
        const rawImports: LangRawImport[] = [];
        const structures: StructureNode[] = [];
        const collector = new FunctionCollector(relativePath);
        const testSuites: string[] = [];
        const testCases: string[] = [];

        const isTestFile = this.detectFileKind(relativePath) === "test";
        let packageName = "";

        for (let i = 0; i < rootNode.namedChildCount; i++) {
            const node = rootNode.namedChild(i);
            if (!node) continue;

            switch (node.type) {
                case "package_clause": {
                    const id = node.namedChild(0);
                    if (id) packageName = id.text;
                    break;
                }

                case "import_declaration": {
                    // single import or import_spec_list
                    const specs: TSNode[] = [];
                    const collectSpecs = (n: TSNode) => {
                        if (n.type === "import_spec") specs.push(n);
                        for (let j = 0; j < n.namedChildCount; j++) {
                            const c = n.namedChild(j);
                            if (c) collectSpecs(c);
                        }
                    };
                    collectSpecs(node);

                    for (const spec of specs) {
                        const pathNode = spec.childForFieldName("path");
                        if (!pathNode) continue;
                        const importPath = pathNode.text.replace(/^"|"$/g, "");
                        const aliasNode = spec.childForFieldName("name");
                        const symbols = aliasNode ? [aliasNode.text] : [];
                        rawImports.push({
                            specifier: importPath,
                            symbols,
                            kind: "static",
                        });
                    }
                    break;
                }

                case "function_declaration": {
                    const nameNode = node.childForFieldName("name");
                    if (!nameNode) break;
                    const name = nameNode.text;
                    const calls = extractCallNames(node, "call_expression", "function", calleeName);

                    const isTestFn = isTestFile && /^(Test|Benchmark|Fuzz|Example)[A-Z_]/.test(name);
                    if (isTestFn) testCases.push(name);

                    collector.add({
                        name,
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        isExported: isExportedGo(name),
                        kind: isTestFn ? "test" : "function",
                        calls,
                    });
                    break;
                }

                case "method_declaration": {
                    const nameNode = node.childForFieldName("name");
                    const receiver = node.childForFieldName("receiver");
                    if (!nameNode) break;
                    const recvType = receiver ? receiverTypeName(receiver) : null;
                    const bare = nameNode.text;
                    const name = recvType ? `${recvType}.${bare}` : bare;
                    const calls = extractCallNames(node, "call_expression", "function", calleeName);

                    collector.add({
                        name,
                        startLine: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        isExported: isExportedGo(bare),
                        kind: "method",
                        calls,
                        parentId: recvType ? `${relativePath}::${recvType}` : undefined,
                    });
                    break;
                }

                case "type_declaration": {
                    // type Foo struct{...} / type Bar interface{...}
                    for (let j = 0; j < node.namedChildCount; j++) {
                        const spec = node.namedChild(j);
                        if (spec?.type !== "type_spec") continue;
                        const nameNode = spec.childForFieldName("name");
                        if (!nameNode) continue;
                        structures.push({
                            id: `${relativePath}::${nameNode.text}`,
                            name: nameNode.text,
                            filePath: relativePath,
                            startLine: spec.startPosition.row + 1,
                            endLine: spec.endPosition.row + 1,
                            isExported: isExportedGo(nameNode.text),
                        });
                    }
                    break;
                }
            }
        }

        // ERROR-tolerant fallback: if a malformed parse left the top-level loop
        // empty, sweep the whole tree for func/method decls under ERROR nodes.
        if (collector.functions.length === 0 && rootNode.hasError) {
            sweepFunctionsOnError(rootNode, new Set(["function_declaration", "method_declaration"]), (n) => {
                const nameNode = n.childForFieldName("name");
                if (!nameNode) return;
                const calls = extractCallNames(n, "call_expression", "function", calleeName);
                if (n.type === "method_declaration") {
                    const receiver = n.childForFieldName("receiver");
                    const recvType = receiver ? receiverTypeName(receiver) : null;
                    const bare = nameNode.text;
                    collector.add({
                        name: recvType ? `${recvType}.${bare}` : bare,
                        startLine: n.startPosition.row + 1,
                        endLine: n.endPosition.row + 1,
                        isExported: isExportedGo(bare),
                        kind: "method",
                        calls,
                        parentId: recvType ? `${relativePath}::${recvType}` : undefined,
                    });
                } else {
                    const name = nameNode.text;
                    collector.add({
                        name,
                        startLine: n.startPosition.row + 1,
                        endLine: n.endPosition.row + 1,
                        isExported: isExportedGo(name),
                        kind: "function",
                        calls,
                    });
                }
            });
        }

        const hasMain = collector.functions.some((f) => f.name === "main");
        const hasStartupSignals = packageName === "main" && hasMain;

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
