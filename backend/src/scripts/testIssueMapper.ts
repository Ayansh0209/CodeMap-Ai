import { mapIssueToCode } from "../parser/issueMapper";
import type { SearchIndex } from "../models/schema";

// ── Mock Index ───────────────────────────────────────────────────────────────

const mockIndex: SearchIndex = {
    generatedAt: new Date().toISOString(),
    entries: [
        {
            id: "src/auth/authService.ts",
            type: "file",
            name: "authService.ts",
            filePath: "src/auth/authService.ts",
            tokens: ["src", "auth", "authservice", "ts", "service", "typescript", "source"],
            usageCount: 15,
            hubScore: 80,
            isEntryPoint: false,
            isDeadCode: false,
        },
        {
            id: "src/auth/authService.ts::login",
            type: "export",
            name: "login",
            filePath: "src/auth/authService.ts",
            tokens: ["login", "src", "auth", "authservice", "ts", "function"],
            usageCount: 5,
        },
        {
            id: "src/store/userReducer.ts",
            type: "file",
            name: "userReducer.ts",
            filePath: "src/store/userReducer.ts",
            tokens: ["src", "store", "userreducer", "ts", "reducer", "state", "typescript", "source"],
            usageCount: 10,
            hubScore: 50,
            isEntryPoint: false,
            isDeadCode: false,
        },
        {
            id: "src/api/routes/loginRoute.ts",
            type: "file",
            name: "loginRoute.ts",
            filePath: "src/api/routes/loginRoute.ts",
            tokens: ["src", "api", "routes", "loginroute", "ts", "route", "typescript", "source"],
            usageCount: 2,
            hubScore: 20,
            isEntryPoint: true,
            isDeadCode: false,
        },
        {
            id: "src/middleware/authMiddleware.ts",
            type: "file",
            name: "authMiddleware.ts",
            filePath: "src/middleware/authMiddleware.ts",
            tokens: ["src", "middleware", "authmiddleware", "ts", "middleware", "typescript", "source", "auth"],
            usageCount: 20,
            hubScore: 90,
            isEntryPoint: false,
            isDeadCode: false,
        },
    ],
};

// ── Runner ───────────────────────────────────────────────────────────────────

function runTest(testName: string, query: string, expectedTopFile: string) {
    const result = mapIssueToCode(query, mockIndex, 5);
    if (result.topFiles.length === 0) {
        console.error("  ❌ FAILED: No files matched");
        return;
    }

    const actualTopFile = result.topFiles[0].filePath;
    
    if (actualTopFile === expectedTopFile) {
    } else {
        console.error(`  ❌ FAILED`);
        console.error(`     Expected: ${expectedTopFile}`);
        console.error(`     Actual:   ${actualTopFile}`);
    }
    for (const reason of result.topFiles[0].matchedReasons.slice(0, 3)) {
    }
}

// ── Test Cases ───────────────────────────────────────────────────────────────
runTest(
    "Auth bug targeting login function",
    "Users cannot login, the auth service is throwing an error",
    "src/auth/authService.ts"
);

runTest(
    "Reducer state bug",
    "Fix user state bug in the userReducer",
    "src/store/userReducer.ts"
);

runTest(
    "Route API issue",
    "The /api/routes/loginRoute is returning 500",
    "src/api/routes/loginRoute.ts"
);

runTest(
    "Middleware bug",
    "Auth middleware is blocking requests",
    "src/middleware/authMiddleware.ts"
);
