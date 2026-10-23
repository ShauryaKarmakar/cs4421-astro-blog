import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every variable db.ts treats as database configuration. Clearing them puts the
// process in the state a misconfigured deployment starts in.
const databaseConfigurationKeys = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
  'PGSSLROOTCERT',
  'SUPABASE_CA_CERT',
];

describe('health endpoint without database configuration', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of databaseConfigurationKeys) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalValues.clear();
  });

  it('imports the database module instead of throwing during module loading', async () => {
    const db = await import('../src/lib/db');

    expect(db.healthPool).toBeDefined();
    await expect(db.healthPool.query('SELECT 1')).rejects.toBeInstanceOf(
      db.DatabaseConfigurationError,
    );
  });

  it('answers 503 with the unavailable payload instead of a 500', async () => {
    const { GET } = await import('../src/pages/api/health');

    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).not.toContain('DATABASE_URL');
    expect(body).not.toContain('postgres');
  });

  it('still returns 503 when the production role assertion runs without configuration', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      vi.resetModules();
      const { GET } = await import('../src/pages/api/health');

      const response = await GET({} as never);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable' });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
