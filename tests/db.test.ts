// tests/db.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Pool } from 'pg';

let pool: Pool;

describe('db utility', () => {
  beforeAll(async () => {
    // Set the environment variable before importing the module
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb';
    // Now import the module
    // We need to reset the module cache to ensure it picks up the new env variable
    vi.resetModules();
    const { pool: importedPool } = await import('../src/lib/db');
    pool = importedPool;
  });

  it('should have a pool defined', () => {
    expect(pool).toBeDefined();
  });
});