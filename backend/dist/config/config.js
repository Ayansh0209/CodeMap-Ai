"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing env variable: ${name}`);
    }
    return value;
}
function optional(name) {
    return process.env[name] ?? "";
}
exports.config = {
    app: {
        port: Number(process.env.PORT || 5000),
    },
    redis: {
        url: required("REDIS_URL"),
    },
    github: {
        token: required("GITHUB_TOKEN"),
    },
    r2: {
        accountId: optional("R2_ACCOUNT_ID"),
        accessKeyId: optional("R2_ACCESS_KEY_ID"),
        secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
        bucketName: optional("R2_BUCKET_NAME"),
        publicUrl: optional("R2_PUBLIC_URL"),
    },
    queue: {
        maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 3),
        maxQueueSize: Number(process.env.MAX_QUEUE_SIZE || 100),
        jobTimeoutMs: Number(process.env.JOB_TIMEOUT_MS || 600000),
    },
    gemini: {
        apiKey: optional("GEMINI_API_KEY"),
    },
};
