import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url)),
		},
	},
	test: {
		exclude: [
			'hello-cdk/**',
			'node_modules/**',
			'dist/**',
			'.astro/**',
			// A linked worktree lives under .git/, and its own node_modules and
			// test files are not this project's source. Without this, a local
			// run scans another checkout and reports its failures as ours.
			'.git/**',
		],
	},
});