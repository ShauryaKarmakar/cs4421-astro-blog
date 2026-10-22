// src/lib/rateLimiter.ts
/**
 * In-process, memory-bounded rate limiter.
 *
 * ARCHITECTURAL LIMITATION & ASSUMPTIONS:
 * This rate limiter maintains state local to a single Node.js process.
 * In the planned ECS Fargate + ALB deployment:
 * 1. Requests are distributed across multiple container tasks, each with isolated memory.
 *    Consequently, this local limiter cannot enforce unified rate limits across tasks
 *    or survive task restarts/scaling.
 * 2. Production rate limiting must be implemented at the edge/infrastructure layer
 *    (e.g., AWS WAF rate-based rules on the Application Load Balancer) or with a shared
 *    distributed store (e.g., Redis / ElastiCache).
 * 3. This in-process limiter provides defence-in-depth, local/single-instance protection,
 *    and automated testing guards without unbounded memory accumulation.
 *
 * PROXY & IP FORWARDING BEHAVIOR:
 * When deployed behind an AWS Application Load Balancer (ALB), the ALB appends the
 * connecting remote client IP to the end of any incoming X-Forwarded-For header:
 *   X-Forwarded-For: <client-spoofed-entries...>, <real-connecting-alb-client-ip>
 * Therefore, getClientIP() extracts the rightmost (last) non-empty IP entry from
 * X-Forwarded-For. If X-Forwarded-For is not present, it checks X-Real-IP, falling back
 * to 'unknown' if neither is provided.
 */

export interface RateLimitInfo {
  count: number;
  firstAttempt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private store: Map<string, RateLimitInfo>;
  private windowMs: number;
  private maxRequests: number;
  private maxEntries: number;

  constructor(windowMs: number, maxRequests: number, maxEntries = 10_000) {
    this.store = new Map();
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /**
   * Evicts expired entries from the oldest records in the Map.
   * Map iteration preserves insertion/update order.
   */
  private evictExpired(now: number, maxChecks = 50): void {
    let checked = 0;
    for (const [key, record] of this.store) {
      if (now - record.firstAttempt > this.windowMs) {
        this.store.delete(key);
      }
      checked++;
      if (checked >= maxChecks) {
        break;
      }
    }
  }

  /**
   * Ensures storage does not exceed maxEntries.
   * Evicts the oldest entry in the Map (FIFO/LRU).
   */
  private ensureCapacity(): void {
    while (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * Check if the request is rate limited.
   * @param key - Unique identifier for the client (e.g., IP address)
   * @param now - Current timestamp in milliseconds (defaults to Date.now())
   * @returns { allowed: boolean, remaining: number, resetTime: number, retryAfterSeconds: number }
   */
  checkLimit(key: string, now: number = Date.now()): RateLimitResult {
    this.evictExpired(now);

    const record = this.store.get(key);

    if (!record) {
      this.ensureCapacity();
      const resetTime = now + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));
      this.store.set(key, { count: 1, firstAttempt: now });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime,
        retryAfterSeconds,
      };
    }

    const { count, firstAttempt } = record;

    // If the window has passed, reset the count
    if (now - firstAttempt > this.windowMs) {
      const resetTime = now + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));
      this.store.delete(key);
      this.store.set(key, { count: 1, firstAttempt: now });
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime,
        retryAfterSeconds,
      };
    }

    // Increment count
    const newCount = count + 1;
    this.store.delete(key);
    this.store.set(key, { count: newCount, firstAttempt });

    const resetTime = firstAttempt + this.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetTime - now) / 1000));

    if (newCount > this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfterSeconds,
      };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - newCount,
      resetTime,
      retryAfterSeconds,
    };
  }
}

// Export a limiter for authentication endpoints (5 attempts per 15 minutes)
export const authLimiter = new RateLimiter(15 * 60 * 1000, 5);

/**
 * Extracts the remote client IP from request headers.
 * Under an AWS ALB deployment, ALB appends the remote client IP to the end of X-Forwarded-For.
 * Taking the rightmost non-empty IP entry ensures client-spoofed prefix entries are ignored.
 */
export function getClientIP(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp && realIp.trim().length > 0) {
    return realIp.trim();
  }

  return 'unknown';
}

export default { authLimiter, getClientIP, RateLimiter };
