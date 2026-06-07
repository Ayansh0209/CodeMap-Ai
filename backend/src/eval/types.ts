// src/eval/types.ts
// Shared types for the CodeMap AI Issue Mapping Evaluation Framework.

// ── Repository sizing ─────────────────────────────────────────────────────────

export type RepoSize = "small" | "medium" | "large" | "very_large";

// ── Dataset entry ─────────────────────────────────────────────────────────────

export interface DatasetEntry {
    /** Unique ID for this benchmark entry */
    id: string;
    owner: string;
    repo: string;
    size: RepoSize;
    /** The issue that exists BEFORE the PR is opened */
    issueNumber: number;
    /** The PR that actually fixed the issue */
    prNumber: number;
    /** Short description of what this benchmark tests */
    description: string;
    /** Optional: label for failure pattern tracking */
    tags?: string[];
}

// ── PR validation ─────────────────────────────────────────────────────────────

export type PRRejectionReason =
    | "not_merged"
    | "too_many_files"         // >50 changed files — likely a massive refactor
    | "docs_only"              // >80% of files are documentation
    | "deps_only"              // only package.json/lock file changes
    | "generated_only"        // only generated files changed
    | "issue_not_found"
    | "pr_not_found"
    | "no_code_files"
    | "unsupported_language";

export interface PRValidationResult {
    entry: DatasetEntry;
    valid: boolean;
    rejectionReason?: PRRejectionReason;
    /** Actual files changed in the PR (only populated when valid=true) */
    prFiles: string[];
    /** Number of code files (non-doc, non-generated) in the PR */
    codeFileCount: number;
    /** Summary for reporting */
    summary: string;
}

// ── Miss classification ───────────────────────────────────────────────────────

export type MissCategory =
    | "schema_model"       // .graphql, .prisma, model files, entity files
    | "config"             // config files, env, tsconfig
    | "test"               // test files, spec files
    | "documentation"      // .md, .mdx, docs
    | "infrastructure"     // docker, k8s, ci, makefiles
    | "business_logic"     // all other source files
    | "generated";         // generated files, migrations

export interface ClassifiedMiss {
    filePath: string;
    category: MissCategory;
}

// ── Per-issue evaluation result ───────────────────────────────────────────────

export interface IssueEvalResult {
    entry: DatasetEntry;
    issueTitle: string;
    issueUrl: string;

    // Raw outputs
    predictedFiles: Array<{ fileId: string; confidence: number; reason: string }>;
    actualFiles: string[];

    // Derived sets
    matchedFiles: string[];
    missedFiles: string[];
    extraFiles: string[];    // predicted but not in PR (may still be relevant)

    // Metrics
    precision: number;
    recall: number;
    f1: number;

    // Recall@K
    recallAt5: number;
    recallAt10: number;
    recallAt20: number;

    // Miss analysis
    classifiedMisses: ClassifiedMiss[];

    // Pipeline metadata
    pipelineSource: "cache" | "deterministic" | "ai" | "error";
    snippetCount: number;
    usedNewPipeline: boolean;
    errorMessage?: string;

    // Timing
    durationMs: number;
    timestamp: string;
}

// ── Aggregate statistics ──────────────────────────────────────────────────────

export interface AggregateMetrics {
    issueCount: number;
    avgPrecision: number;
    avgRecall: number;
    avgF1: number;
    avgRecallAt5: number;
    avgRecallAt10: number;
    avgRecallAt20: number;
    /** % of issues where F1 > 0 */
    nonZeroF1Rate: number;
    /** % of issues where recall > 0.5 */
    highRecallRate: number;
}

export interface SizeBreakdown {
    small: AggregateMetrics;
    medium: AggregateMetrics;
    large: AggregateMetrics;
    very_large: AggregateMetrics;
}

export interface RepoBreakdown {
    [repoKey: string]: AggregateMetrics;
}

// ── Miss pattern analysis ─────────────────────────────────────────────────────

export interface MissPattern {
    category: MissCategory;
    count: number;
    percentage: number;
    exampleFiles: string[];
}

// ── Recommendation ────────────────────────────────────────────────────────────

export interface Recommendation {
    rank: number;
    title: string;
    description: string;
    impactedMetric: "recall" | "precision" | "f1" | "recall@k";
    estimatedImpact: "high" | "medium" | "low";
    evidenceSummary: string;
}

// ── Final report ──────────────────────────────────────────────────────────────

export interface EvaluationReport {
    generatedAt: string;
    totalIssuesEvaluated: number;
    totalIssuesInDataset: number;
    validDatasetEntries: number;
    skippedEntries: number;

    overall: AggregateMetrics;
    bySize: SizeBreakdown;
    byRepo: RepoBreakdown;

    missPatterns: MissPattern[];
    recommendations: Recommendation[];

    perIssue: IssueEvalResult[];
    failedIssues: Array<{ entry: DatasetEntry; errorMessage: string }>;
}
