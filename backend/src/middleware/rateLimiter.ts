import { Request, Response, NextFunction } from "express";
import { redisConnection } from "../queue/jobQueue";

// Per-device caps (the normal, intended limit for one browser).
const MAX_CHAT_REQUESTS_PER_DAY = 20;
const MAX_CHAT_TOKENS_PER_DAY = 120000;
// Per-IP backstop: a single IP can rotate/forge `x-device-id` to mint fresh
// device buckets, so we ALSO cap by IP. Set higher than the device cap to allow
// a handful of genuine devices behind one NAT (office / campus / household).
const MAX_IP_REQUESTS_PER_DAY = 80;
// Global daily ceiling across ALL devices — a hard cost circuit-breaker so the
// shared instance can't run up a bill the (solo, self-funded) author can't pay.
// Tune via env; the default is generous enough for normal early traffic.
const MAX_GLOBAL_CHAT_REQUESTS_PER_DAY = Number(process.env.MAX_GLOBAL_CHAT_REQUESTS_PER_DAY || 2000);
const ONE_DAY_SECONDS = 86400;

/**
 * The device bucket id from the client header, or null when absent/invalid.
 * We accept only a bounded, alphanumeric id (our client sends a UUID) so a
 * crafted header can't bloat memory or pollute the Redis keyspace.
 */
export function getDeviceIdentifier(req: Request): string | null {
    const raw = req.headers["x-device-id"];
    if (typeof raw === "string") {
        const clean = raw.trim().replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
        if (clean.length >= 8) return `device:${clean}`;
    }
    return null;
}

export function getIpIdentifier(req: Request): string {
    const ip = req.ip || req.socket.remoteAddress || "unknown-ip";
    return `ip:${ip}`;
}

/** Primary identifier used for token accounting (device if present, else IP). */
export function getClientIdentifier(req: Request): string {
    return getDeviceIdentifier(req) ?? getIpIdentifier(req);
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
        const dateStr = getDateString();
        const device = getDeviceIdentifier(req);
        const ip = getIpIdentifier(req);

        // Check device (if present) + IP + the global ceiling. Any one tripping
        // returns 429; the global one protects total daily spend across everyone.
        const buckets: { id: string; max: number }[] = [];
        if (device) buckets.push({ id: device, max: MAX_CHAT_REQUESTS_PER_DAY });
        buckets.push({ id: ip, max: MAX_IP_REQUESTS_PER_DAY });
        buckets.push({ id: "global", max: MAX_GLOBAL_CHAT_REQUESTS_PER_DAY });

        const reqKeys = buckets.map((b) => `rate-limit:req:${b.id}:${dateStr}`);
        const counts = await Promise.all(reqKeys.map((k) => redisConnection.get(k)));

        for (let i = 0; i < buckets.length; i++) {
            const used = counts[i] ? parseInt(counts[i] as string, 10) : 0;
            if (used >= buckets[i].max) {
                return res.status(429).json({
                    error: "Rate limit exceeded",
                    message: "You've reached the daily chat limit. Please try again tomorrow.",
                });
            }
        }

        // Token cap on the primary identifier (device, else IP).
        const primary = device ?? ip;
        const tokKey = `rate-limit:tok:${primary}:${dateStr}`;
        const rawTokens = await redisConnection.get(tokKey);
        const tokens = rawTokens ? parseInt(rawTokens, 10) : 0;
        if (tokens >= MAX_CHAT_TOKENS_PER_DAY) {
            return res.status(429).json({
                error: "Rate limit exceeded",
                message: "You've reached today's usage limit. Please try again tomorrow.",
            });
        }

        // Increment every request bucket we checked.
        const multi = redisConnection.multi();
        for (const k of reqKeys) {
            multi.incr(k);
            multi.expire(k, ONE_DAY_SECONDS);
        }
        await multi.exec();

        // Token tracking in the endpoint keys off this.
        (req as any).clientIdentifier = primary;

        next();
    } catch (err) {
        console.error("[rateLimiter] Error checking rate limits:", err);
        // Fail-open to avoid blocking users if Redis is down
        next();
    }
}
