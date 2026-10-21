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
		],
	},
});