import { isIP } from 'node:net';

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number;
  resetAt: number;
};

type Bucket = { count: number; resetAt: number };
const globalStore = globalThis as typeof globalThis & { examhubRateBuckets?: Map<string, Bucket> };
const buckets = globalStore.examhubRateBuckets ??= new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const candidate = forwarded.startsWith('[') && forwarded.endsWith(']') ? forwarded.slice(1, -1) : forwarded;
  return isIP(candidate) ? candidate : 'local';
}

/**
 * Per-IP fixed-window limiter for a single Node process. Nginx applies its own
 * edge rate limit first; this protects the application if the proxy is bypassed.
 */
export function checkRateLimit(request: Request, scope: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size >= MAX_BUCKETS) {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
  }

  const key = `${scope}:${clientIp(request)}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  const allowed = bucket.count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    resetAt: Math.ceil(bucket.resetAt / 1000),
  };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetAt),
  };
}
