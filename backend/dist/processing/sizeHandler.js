"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getParseMode = getParseMode;
const path_1 = __importDefault(require("path"));
const KB = 1024;
const MB = 1024 * KB;
function getParseMode(absolutePath, relativePath, sizeBytes) {
    const filename = path_1.default.basename(relativePath).toLowerCase();
    // skip minified / bundled files
    if (filename.includes(".min.") ||
        filename.includes(".bundle.") ||
        filename.includes(".chunk.")) {
        return {
            absolutePath,
            relativePath,
            sizeBytes,
            mode: "skip",
            skipReason: "minified/bundled file",
        };
    }
    // type definition files
    if (filename.endsWith(".d.ts")) {
        return {
            absolutePath,
            relativePath,
            sizeBytes,
            mode: "imports-only",
            skipReason: "type definition file (imports only)",
        };
    }
    // small files → full parse
    if (sizeBytes < 500 * KB) {
        return {
            absolutePath,
            relativePath,
            sizeBytes,
            mode: "full",
        };
    }
    // everything else → imports only
    return {
        absolutePath,
        relativePath,
        sizeBytes,
        mode: "imports-only",
        skipReason: sizeBytes > 2 * MB
            ? "large file - imports only for performance"
            : undefined,
    };
}
