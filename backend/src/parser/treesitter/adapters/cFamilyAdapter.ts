// src/parser/treesitter/adapters/cFamilyAdapter.ts
// ─────────────────────────────────────────────────────────────────────────────
// C and C++ adapters — share one extraction core, differ in grammar + extras.
//
// Grammar nodes handled:
//   preproc_include            #include "x.h" (string_literal) vs <x> (system_lib_string)
//                              — found ANYWHERE (incl. inside #ifdef blocks)
//   function_definition        declarator chain → identifier; static = not exported
//   declaration of prototypes  skipped (definitions only — no duplicate nodes)
//   struct/union/enum_specifier with body → StructureNode
//   C++ extras: class_specifier, namespace_definition, template_declaration,
//               qualified method definitions (Foo::bar → "Foo.bar"),
//               destructors/operators, field_expression calls (obj.method())
//   gtest TEST()/TEST_F() macros → test cases
//   main()                     → startup signal
// ─────────────────────────────────────────────────────────────────────────────

import type { Node as TSNode } from "web-tree-sitter";
import { Language, FileKind, StructureNode, FunctionNode } from "../../../models/graph";
import { LanguageAdapter, ExtractResult, LangRawImport } from "../types";
import { walk, FunctionCollector, inTestDir } from "./util";

function calleeName(callee: TSNode): string | null {
    switch (callee.type) {
        case "identifier":
        case "field_identifier":
            return callee.text;
        case "field_expression": {
            const field = callee.childForFieldName("field");
            return field ? field.text : null;
        }
        case "qualified_identifier": {
            // ns::Class::method → "method"
            const name = callee.childForFieldName("name");
            return name ? calleeName(name) : callee.text.split("::").pop() ?? null;
        }
        case "template_function": {
            const name = callee.childForFieldName("name");
            return name ? name.text : null;
        }
        case "parenthesized_expression": {
            const inner = callee.namedChild(0);
            return inner ? calleeName(inner) : null;
        }
        default:
            return null;
    }
}

function extractCalls(node: TSNode): string[] {
    const calls = new Set<string>();
    walk(node, (n) => {
        if (n.type === "call_expression") {
            const callee = n.childForFieldName("function");
            if (callee) {
                const name = calleeName(callee);
                if (name) calls.add(name);
            }
        }
    });
    return [...calls];
}

/** descend the declarator chain to find the function name */
function functionNameFromDefinition(def: TSNode): { name: string; qualified: boolean } | null {
    let decl = def.childForFieldName("declarator");
    // unwrap pointer/reference declarators: char *foo() {}
    while (decl && decl.type !== "function_declarator") {
        decl = decl.childForFieldName("declarator") ?? decl.namedChild(0);
        if (!decl) return null;
        if (decl.type === "function_declarator") break;
        if (
            decl.type !== "pointer_declarator" &&
            decl.type !== "reference_declarator" &&
            decl.type !== "parenthesized_declarator" &&
            decl.type !== "function_declarator"
        ) {
            // not a function shape we understand
            if (decl.childForFieldName("declarator") === null) return null;
        }
    }
    if (!decl || decl.type !== "function_declarator") return null;

    const inner = decl.childForFieldName("declarator");
    if (!inner) return null;

    switch (inner.type) {
        case "identifier":
        case "field_identifier":
            return { name: inner.text, qualified: false };
        case "qualified_identifier": {
            // Foo::bar / ns::Foo::bar → "Foo.bar" (matches builder's Class.method indexing)
            const segments = inner.text.split("::").filter(Boolean);
            const tail = segments.slice(-2);
            return { name: tail.join("."), qualified: true };
        }
        case "destructor_name":
            return { name: inner.text.replace("~", "destructor_"), qualified: false };
        case "operator_name":
            return { name: inner.text.replace(/\s+/g, ""), qualified: false };
        default:
            return null;
    }
}

function isStaticDefinition(def: TSNode): boolean {
    for (let i = 0; i < def.childCount; i++) {
        const c = def.child(i);
        if (!c) continue;
        if (c.type === "storage_class_specifier" && c.text === "static") return true;
        if (c.type === "function_declarator" || c.type === "compound_statement") break;
    }
    return false;
}

abstract class CFamilyAdapterBase implements LanguageAdapter {
    abstract languageId: Language;
    abstract extensions: string[];
    abstract wasmName: string;

    detectFileKind(relativePath: string): FileKind {
        const base = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
        if (
            inTestDir(relativePath) ||
            /(_test|_tests|\.test)\.(c|cc|cpp|cxx)$/.test(base) ||
            base.startsWith("test_")
        ) return "test";
        if (/\.(h|hpp|hh|hxx)$/.test(base)) return "declaration";
        return "source";
    }

    extract(rootNode: TSNode, content: string, relativePath: string): ExtractResult {
        const rawImports: LangRawImport[] = [];
        const structures: StructureNode[] = [];
        const collector = new FunctionCollector(relativePath);
        const testSuites = new Set<string>();
        const testCases: string[] = [];

        // ── includes — anywhere in the tree (handles #ifdef-wrapped includes) ──
        walk(rootNode, (n) => {
            if (n.type === "preproc_include") {
                const pathNode = n.childForFieldName("path");
                if (pathNode) {
                    const isSystem = pathNode.type === "system_lib_string";
                    const spec = pathNode.text.replace(/^["<]|[">]$/g, "");
                    rawImports.push({
                        specifier: spec,
                        symbols: [],
                        kind: "static",
                        meta: { isSystemInclude: isSystem },
                    });
                }
            }
        });

        // ── definitions — recursive visit handling namespaces/classes/templates ──
        const visit = (node: TSNode, classCtx: { id: string; name: string } | null) => {
            for (let i = 0; i < node.namedChildCount; i++) {
                const child = node.namedChild(i);
                if (!child) continue;

                switch (child.type) {
                    case "function_definition": {
                        this.handleFunctionDef(child, classCtx, collector, relativePath, testSuites, testCases);
                        break;
                    }

                    case "template_declaration": {
                        visit(child, classCtx); // unwrap → inner class/function
                        break;
                    }

                    case "namespace_definition": {
                        const body = child.childForFieldName("body");
                        if (body) visit(body, classCtx);
                        break;
                    }

                    case "linkage_specification": { // extern "C" { ... }
                        visit(child, classCtx);
                        break;
                    }

                    case "class_specifier":
                    case "struct_specifier":
                    case "union_specifier":
                    case "enum_specifier": {
                        const nameNode = child.childForFieldName("name");
                        const body = child.childForFieldName("body");
                        if (nameNode && body) {
                            const structId = `${relativePath}::${nameNode.text}`;
                            structures.push({
                                id: structId,
                                name: nameNode.text,
                                filePath: relativePath,
                                startLine: child.startPosition.row + 1,
                                endLine: child.endPosition.row + 1,
                                isExported: true, // C/C++: visibility is header-driven, not keyword-driven
                            });
                            // inline method definitions inside the class body
                            visit(body, { id: structId, name: nameNode.text });
                        }
                        break;
                    }

                    case "declaration":
                    case "type_definition":
                        // typedef struct {...} Foo; → struct may be nested
                        for (let j = 0; j < child.namedChildCount; j++) {
                            const inner = child.namedChild(j);
                            if (
                                inner &&
                                (inner.type === "struct_specifier" ||
                                    inner.type === "class_specifier" ||
                                    inner.type === "enum_specifier" ||
                                    inner.type === "union_specifier") &&
                                inner.childForFieldName("body")
                            ) {
                                const nameNode =
                                    inner.childForFieldName("name") ??
                                    // typedef: name is the declaration's declarator
                                    child.childForFieldName("declarator");
                                if (nameNode) {
                                    structures.push({
                                        id: `${relativePath}::${nameNode.text}`,
                                        name: nameNode.text,
                                        filePath: relativePath,
                                        startLine: child.startPosition.row + 1,
                                        endLine: child.endPosition.row + 1,
                                        isExported: true,
                                    });
                                }
                            }
                        }
                        break;

                    case "preproc_ifdef":
                    case "preproc_if":
                    case "preproc_else":
                    case "preproc_elif":
                        visit(child, classCtx); // code inside #ifdef blocks
                        break;

                    case "expression_statement": {
                        // gtest: TEST(SuiteName, TestName) { ... } parses as macro call
                        const call = child.namedChild(0);
                        if (call?.type === "call_expression") {
                            const fn = call.childForFieldName("function");
                            if (fn?.type === "identifier" && /^(TEST|TEST_F|TEST_P|TYPED_TEST)$/.test(fn.text)) {
                                const args = call.childForFieldName("arguments");
                                const argTexts = args
                                    ? args.text.replace(/[()]/g, "").split(",").map((s: string) => s.trim())
                                    : [];
                                if (argTexts[0]) testSuites.add(argTexts[0]);
                                if (argTexts[1]) testCases.push(`${argTexts[0]}.${argTexts[1]}`);
                            }
                        }
                        break;
                    }
                }
            }
        };

        visit(rootNode, null);

        const hasStartupSignals = collector.functions.some((f) => f.name === "main");

        return {
            functions: collector.functions,
            structures,
            rawImports,
            testSuites: [...testSuites],
            testCases,
            hasStartupSignals,
        };
    }

    private handleFunctionDef(
        def: TSNode,
        classCtx: { id: string; name: string } | null,
        collector: FunctionCollector,
        relativePath: string,
        testSuites: Set<string>,
        testCases: string[]
    ): void {
        const named = functionNameFromDefinition(def);
        if (!named) return;

        let name = named.name;
        let parentId: string | undefined;

        if (classCtx && !named.qualified) {
            // inline method inside class body
            parentId = classCtx.id;
            name = `${classCtx.name}.${name}`;
        } else if (named.qualified && name.includes(".")) {
            const className = name.split(".")[0];
            parentId = `${relativePath}::${className}`;
        }

        const isMethod = Boolean(parentId);

        collector.add({
            name,
            startLine: def.startPosition.row + 1,
            endLine: def.endPosition.row + 1,
            isExported: !isStaticDefinition(def),
            kind: isMethod ? "method" : "function",
            calls: extractCalls(def),
            parentId,
        });
    }
}

export class CAdapter extends CFamilyAdapterBase {
    languageId = "c" as Language;
    extensions = [".c"];
    wasmName = "c";
}

export class CppAdapter extends CFamilyAdapterBase {
    languageId = "cpp" as Language;
    extensions = [".cpp", ".cc", ".cxx", ".c++"];
    wasmName = "cpp";
}

/**
 * Header adapter — .h/.hpp etc. The grammar used for plain .h depends on what
 * the repo contains (a .h in a pure-C repo must NOT be parsed as C++ — the
 * exact class of bug you hit with .ts imports detected as .js).
 * The registry constructs this with the right grammar per repo.
 */
export class HeaderAdapter extends CFamilyAdapterBase {
    languageId: Language;
    extensions: string[];
    wasmName: string;

    constructor(mode: "c" | "cpp", extensions: string[]) {
        super();
        this.wasmName = mode;
        this.languageId = mode as Language;
        this.extensions = extensions;
    }
}
