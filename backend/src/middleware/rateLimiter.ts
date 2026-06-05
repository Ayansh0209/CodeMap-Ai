import { Request, Response, NextFunction } from "express";
import { redisConnection } from "../queue/jobQueue";

const MAX_CHAT_REQUESTS_PER_DAY = 100;
const MAX_CHAT_TOKENS_PER_DAY = 500000;
const ONE_DAY_SECONDS = 86400;

export function getClientIdentifier(req: Request): string {
    const deviceId = req.headers["x-device-id"];
    if (deviceId && typeof deviceId === "string" && deviceId.trim().length > 0) {
        return `device:${deviceId.trim()}`;
    }
    const ip = req.ip || req.socket.remoteAddress || "unknown-ip";
    return `ip:${ip}`;
}

export function getDateString(): string {
    const now = new Date();
    // YYYY-MM-DD
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
    try {
        const identifier = getClientIdentifier(req);
        const dateStr = getDateString();

        const reqKey = `rate-limit:req:${identifier}:${dateStr}`;
        const tokKey = `rate-limit:tok:${identifier}:${dateStr}`;

        // Get current usage
        const [rawRequests, rawTokens] = await Promise.all([
            redisConnection.get(reqKey),
            redisConnection.get(tokKey),
        ]);

        const requests = rawRequests ? parseInt(rawRequests, 10) : 0;
        const tokens = rawTokens ? parseInt(rawTokens, 10) : 0;

        if (requests >= MAX_CHAT_REQUESTS_PER_DAY) {
            return res.status(429).json({
                error: "Rate limit exceeded",
                message: `You have reached the limit of ${MAX_CHAT_REQUESTS_PER_DAY} chat requests per day.`,
            });
        }

        if (tokens >= MAX_CHAT_TOKENS_PER_DAY) {
            return res.status(429).json({
                error: "Rate limit exceeded",
                message: `You have reached the limit of ${MAX_CHAT_TOKENS_PER_DAY} tokens per day.`,
            });
        }

        // Increment requests count
        const multi = redisConnection.multi();
        multi.incr(reqKey);
        multi.expire(reqKey, ONE_DAY_SECONDS);
        await multi.exec();

        // Attach identifier to request for token tracking in endpoint
        (req as any).clientIdentifier = identifier;
        (req as any).rateLimitKeys = { reqKey, tokKey };

        next();
    } catch (err) {
        console.error("[rateLimiter] Error checking rate limits:", err);
        // Fail-open to avoid blocking users if Redis is down
        next();
    }
}
