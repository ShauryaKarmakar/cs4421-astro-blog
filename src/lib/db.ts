// src/lib/db.ts
import { Pool } from 'pg';
import { createPostgresPoolConfig } from './postgresConfig';

const connectionString = process.env.DATABASE_URL ?? import.meta.env.DATABASE_URL;
const hasPostgresEnvironment = Boolean(
  process.env.PGHOST &&
  process.env.PGUSER &&
  process.env.PGPASSWORD &&
  process.env.PGDATABASE,
);

if (!connectionString && !hasPostgresEnvironment) {
  throw new Error('Set DATABASE_URL or complete PostgreSQL environment variables.');
}

export const pool = new Pool(createPostgresPoolConfig(connectionString));

export default pool;