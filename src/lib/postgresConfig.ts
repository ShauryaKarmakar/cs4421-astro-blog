import type { PoolConfig } from 'pg';
import { createPostgresPoolConfig as createSharedPostgresPoolConfig } from './postgresConfig.mjs';

/**
 * Typed entry point for the shared implementation in `postgresConfig.mjs`,
 * which the Node migration script can import directly without a TypeScript
 * runtime.
 */
export function createPostgresPoolConfig(
  connectionString: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  poolOptions: PoolConfig = {},
): PoolConfig {
  return createSharedPostgresPoolConfig(connectionString, env, poolOptions);
}
