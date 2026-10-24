import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every variable db.ts treats as database configuration.
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

// A configuration that is present but unacceptable: production requires
// verified TLS, and each test below breaks exactly one of those requirements.
const connectionUrl =
  'postgresql://unibudget_app:smoke-test-password@db.example.com:5432/postgres';

describe('health endpoint with invalid database configuration', () => {
  const originalValues = new Map<string, string | undefined>();
  const originalNodeEnv = process.env.NODE_ENV;

  function applyConfiguration(overrides: Record<string, string>): void {
    for (const key of databaseConfigurationKeys) {
      delete process.env[key];
    }
    // Mirror the container: NODE_ENV=production makes TLS verification
    // mandatory even when no TLS variable is set.
    process.env.NODE_ENV = 'production';
    Object.assign(process.env, overrides);
    vi.resetModules();
  }

  beforeEach(() => {
    originalValues.clear();
    for (const key of databaseConfigurationKeys) {
      originalValues.set(key, process.env[key]);
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.NODE_ENV = originalNodeEnv;
    originalValues.clear();
  });

  it('does not throw while the module loads when the TLS mode is missing', async () => {
    applyConfiguration({ DATABASE_URL: connectionUrl });

    const db = await import('../src/lib/db');

    await expect(db.healthPool.query('SELECT 1')).rejects.toBeInstanceOf(
      db.DatabaseConfigurationError,
    );
  });

  it('rejects connect() with the configuration error instead of an unsupported method', async () => {
    applyConfiguration({ DATABASE_URL: connectionUrl, PGSSLMODE: 'require' });

    const db = await import('../src/lib/db');
    const error = await db.pool
      .connect()
      .then(() => null)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(db.DatabaseConfigurationError);
    expect(error?.message).toContain('PGSSLMODE=verify-full');
  });

  it('answers 503 with the unavailable payload when the TLS mode is missing', async () => {
    applyConfiguration({ DATABASE_URL: connectionUrl });

    const { GET } = await import('../src/pages/api/health');
    const response = await GET({} as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(body).not.toContain('smoke-test-password');
  });

  it('refuses an insecure TLS mode instead of falling back to it', async () => {
    applyConfiguration({ DATABASE_URL: connectionUrl, PGSSLMODE: 'require' });

    const db = await import('../src/lib/db');
    const error = await db.healthPool
      .query('SELECT 1')
      .then(() => null)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(db.DatabaseConfigurationError);
    expect(error?.message).toContain('PGSSLMODE=verify-full');

    const { GET } = await import('../src/pages/api/health');
    expect((await GET({} as never)).status).toBe(503);
  });

  it('answers 503 when verification is required but no CA is configured', async () => {
    applyConfiguration({
      DATABASE_URL: connectionUrl,
      PGSSLMODE: 'verify-full',
    });

    const db = await import('../src/lib/db');
    const error = await db.healthPool
      .query('SELECT 1')
      .then(() => null)
      .catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(db.DatabaseConfigurationError);
    expect(error?.message).toMatch(/SUPABASE_CA_CERT|PGSSLROOTCERT/);

    const { GET } = await import('../src/pages/api/health');
    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });

  it('answers 503 when the configured CA file cannot be read', async () => {
    applyConfiguration({
      DATABASE_URL: connectionUrl,
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: 'C:/nonexistent/unibudget-smoke-ca.crt',
    });

    const { GET } = await import('../src/pages/api/health');
    const response = await GET({} as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('never reports healthy for a rejected TLS mode', async () => {
    applyConfiguration({ DATABASE_URL: connectionUrl, PGSSLMODE: 'prefer' });

    const { GET } = await import('../src/pages/api/health');

    expect((await GET({} as never)).status).not.toBe(200);
  });
});
