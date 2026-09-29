import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: [
			'hello-cdk/**',
			'node_modules/**',
			'dist/**',
			'.astro/**',
		],
	},
});