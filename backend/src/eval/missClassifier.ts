// src/eval/missClassifier.ts
// ─────────────────────────────────────────────────────────────────────────────
// Classifies missed files into semantic categories for failure pattern analysis.
//
// Categories (mutually exclusive, ordered by specificity):
//   schema_model    — GraphQL schemas, Prisma, DB models, entities, DTOs
//   config          — config files, env, tsconfig, jest.config, etc.
//   test            — test and spec files
//   documentation   — markdown, mdx, docs
//   infrastructure  — docker, CI, k8s, makefiles, helm charts
//   generated       — migration files, generated code, protobuf output
//   business_logic  — everything else (service layers, controllers, handlers)
// ─────────────────────────────────────────────────────────────────────────────

import type { MissCategory, ClassifiedMiss } from "./types";

// ── Matchers ──────────────────────────────────────────────────────────────────

function isSchema(filePath: string): boolean {
    const p = filePath.toLowerCase();
    return (
        p.endsWith(".graphql") ||
        p.endsWith(".gql") ||
        p.endsWith("schema.prisma") ||
        p.endsWith(".prisma") ||
        p.includes("/models/") ||
        p.includes("/model/") ||
        p.includes("/entities/") ||
        p.includes("/entity/") ||
        p.includes("/dto/") ||
        p.includes("/dtos/") ||
        p.endsWith(".dto.ts") ||
        p.endsWith(".entity.ts") ||
        p.endsWith(".model.ts") ||
        p.endsWith(".schema.ts") ||
        p.endsWith(".types.ts") ||
        p.endsWith("schema.ts") ||
        p.endsWith("types.ts")
    );
}

function isConfig(filePath: string): boolean {
    const p = filePath.toLowerCase();
    const base = p.split("/").pop() ?? p;
    return (
        base.startsWith("tsconfig") ||
        base.startsWith("jest.config") ||
        base.startsWith("vite.config") ||
        base.startsWith("webpack.config") ||
        base.startsWith("babel.config") ||
        base.startsWith("eslint.config") ||
        base.startsWith(".eslintrc") ||
        base.startsWith("prettier.config") ||
        base.startsWith(".prettierrc") ||
        base.startsWith("next.config") ||
        base.startsWith("nuxt.config") ||
        base.startsWith("tailwind.config") ||
        base.startsWith("postcss.config") ||
        base === ".env" ||
        base === ".env.example" ||
        base.startsWith("config.") ||
        p.includes("/config/") ||
        p.includes("/configs/") ||
        p.includes("/configuration/") ||
        p.endsWith(".config.ts") ||
        p.endsWith(".config.js") ||
        p.endsWith(".config.yaml") ||
        p.endsWith(".config.yml")
    );
}

function isTest(filePath: string): boolean {
    const p = filePath.toLowerCase();
    return (
        p.includes(".test.") ||
        p.includes(".spec.") ||
        p.includes("/__tests__/") ||
        p.includes("/__mocks__/") ||
        p.includes("/test/") ||
        p.includes("/tests/") ||
        p.includes("/e2e/") ||
        p.includes("/fixtures/") ||
        p.endsWith("_test.go") ||
        p.endsWith("_test.py") ||
        p.endsWith("_test.rs")
    );
}

function isDocumentation(filePath: string): boolean {
    const p = filePath.toLowerCase();
    return (
        p.endsWith(".md") ||
        p.endsWith(".mdx") ||
        p.endsWith(".rst") ||
        p.endsWith(".txt") ||
        p.endsWith(".adoc") ||
        p.includes("/docs/") ||
        p.includes("/documentation/") ||
        p.includes("/.github/")
    );
}

function isInfrastructure(filePath: string): boolean {
    const p = filePath.toLowerCase();
    const base = p.split("/").pop() ?? p;
    return (
        base === "dockerfile" ||
        base.startsWith("dockerfile.") ||
        base === "docker-compose.yml" ||
        base === "docker-compose.yaml" ||
        base === "makefile" ||
        base === "gemfile" ||
        p.includes("/.github/workflows/") ||
        p.includes("/ci/") ||
        p.includes("/k8s/") ||
        p.includes("/kubernetes/") ||
        p.includes("/helm/") ||
        p.includes("/terraform/") ||
        p.endsWith(".tf") ||
        p.endsWith(".hcl") ||
        p.endsWith("ci.yml") ||
        p.endsWith("ci.yaml")
    );
}

function isGenerated(filePath: string): boolean {
    const p = filePath.toLowerCase();
    return (
        p.includes("/migrations/") ||
        p.includes("/generated/") ||
        p.includes("/vendor/") ||
        p.endsWith(".generated.ts") ||
        p.endsWith(".generated.js") ||
        p.endsWith(".generated.go") ||
        p.endsWith(".pb.go") ||
        p.endsWith(".pb.ts") ||
        p.endsWith("_pb.d.ts") ||
        p.endsWith(".lock")
    );
}

// ── Classifier ────────────────────────────────────────────────────────────────

export function classifyFile(filePath: string): MissCategory {
    if (isDocumentation(filePath)) return "documentation";
    if (isInfrastructure(filePath)) return "infrastructure";
    if (isGenerated(filePath)) return "generated";
    if (isTest(filePath)) return "test";
    if (isConfig(filePath)) return "config";
    if (isSchema(filePath)) return "schema_model";
    return "business_logic";
}

export function classifyMisses(missedFiles: string[]): ClassifiedMiss[] {
    return missedFiles.map(filePath => ({
        filePath,
        category: classifyFile(filePath),
    }));
}

export function aggregateMissPatterns(
    allMisses: ClassifiedMiss[]
): Array<{ category: MissCategory; count: number; percentage: number; exampleFiles: string[] }> {
    const total = allMisses.length;
    if (total === 0) return [];

    const counts = new Map<MissCategory, string[]>();
    for (const miss of allMisses) {
        const arr = counts.get(miss.category) ?? [];
        arr.push(miss.filePath);
        counts.set(miss.category, arr);
    }

    return Array.from(counts.entries())
        .map(([category, files]) => ({
            category,
            count: files.length,
            percentage: Math.round((files.length / total) * 100 * 10) / 10,
            exampleFiles: files.slice(0, 5),
        }))
        .sort((a, b) => b.count - a.count);
}
