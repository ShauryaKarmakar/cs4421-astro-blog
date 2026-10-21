import { describe, expect, it } from 'vitest';
import { RateLimiter, getClientIP } from '../src/lib/rateLimiter';

describe('getClientIP', () => {
  it('extracts a single IP from X-Forwarded-For', () => {
    const req = new Request('https://example.test', {
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    expect(getClientIP(req)).toBe('198.51.100.1');
  });

  it('extracts the rightmost ALB-appended IP and ignores client-spoofed prefixes', () => {
    const req = new Request('https://example.test', {
      headers: {
        'x-forwarded-for': '1.2.3.4, 10.0.0.1, 203.0.113.195',
      },
    });
    expect(getClientIP(req)).toBe('203.0.113.195');
  });

  it('handles spaces and empty trailing segments in X-Forwarded-For', () => {
    const req = new Request('https://example.test', {
      headers: {
        'x-forwarded-for': ' 1.1.1.1 , 203.0.113.50 ,   ',
      },
    });
    expect(getClientIP(req)).toBe('203.0.113.50');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is missing', () => {
    const req = new Request('https://example.test', {
      headers: { 'x-real-ip': '192.0.2.1' },
    });
    expect(getClientIP(req)).toBe('192.0.2.1');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is only whitespace or commas', () => {
    const req = new Request('https://example.test', {
      headers: {
        'x-forwarded-for': ' , , ',
        'x-real-ip': '192.0.2.2',
      },
    });
    expect(getClientIP(req)).toBe('192.0.2.2');
  });

  it('returns "unknown" when all IP headers are absent', () => {
    const req = new Request('https://example.test');
    expect(getClientIP(req)).toBe('unknown');
  });
});

describe('RateLimiter in-memory bounds and behavior', () => {
  it('permits requests within the window and blocks when maxRequests is exceeded', () => {
    const limiter = new RateLimiter(60_000, 3, 100);
    const now = 1_000_000;

    const r1 = limiter.checkLimit('ip-1', now);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.checkLimit('ip-1', now + 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.checkLimit('ip-1', now + 2000);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = limiter.checkLimit('ip-1', now + 3000);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSeconds).toBe(57); // 60s window - 3s
  });

  it('resets attempt count after windowMs expires', () => {
    const limiter = new RateLimiter(10_000, 2, 100);
    const start = 1_000_000;

    limiter.checkLimit('ip-2', start);
    limiter.checkLimit('ip-2', start + 1000);
    const blocked = limiter.checkLimit('ip-2', start + 2000);
    expect(blocked.allowed).toBe(false);

    // After window expiration
    const reset = limiter.checkLimit('ip-2', start + 10_001);
    expect(reset.allowed).toBe(true);
    expect(reset.remaining).toBe(1);
  });

  it('strictly bounds storage capacity to maxEntries and evicts oldest entries without timers', () => {
    const maxEntries = 5;
    const limiter = new RateLimiter(60_000, 3, maxEntries);
    const now = 1_000_000;

    for (let i = 1; i <= 10; i++) {
      limiter.checkLimit(`client-${i}`, now + i);
      expect(limiter.size).toBeLessThanOrEqual(maxEntries);
    }

    expect(limiter.size).toBe(maxEntries);
    // client-1 through client-5 were evicted to stay within maxEntries
    const rOld = limiter.checkLimit('client-1', now + 100);
    // client-1 was evicted, so accessing it again starts a fresh count
    expect(rOld.remaining).toBe(2);
    expect(limiter.size).toBe(maxEntries);
  });

  it('evicts expired entries on access to prevent memory accumulation', () => {
    const limiter = new RateLimiter(5_000, 3, 100);
    const now = 1_000_000;

    limiter.checkLimit('old-1', now);
    limiter.checkLimit('old-2', now);
    expect(limiter.size).toBe(2);

    // Later, beyond the 5s window
    limiter.checkLimit('new-1', now + 6_000);
    // Expired 'old-1' and 'old-2' are pruned during evictExpired
    expect(limiter.size).toBe(1);
  });
});
