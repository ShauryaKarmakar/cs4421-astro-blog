// @ts-check
//
// Static build for the public UniBudget blog.
//
// The budgeting application is rendered by the Node adapter configured in
// `astro.config.mjs`; it must keep building exactly as before. This config is
// the deployment source for the S3/CloudFront site, so it deliberately:
//
//   - renders with `output: 'static'` (no adapter, no runtime server),
//   - reads pages from `src-static/` so API routes, middleware, sessions and
//     database-backed dashboard pages are never part of the artifact,
//   - writes to `dist-static/` so it can never overwrite `dist/` (the SSR
//     build output) on a developer machine or in CI.
//
// Shared components, layouts, styles and content collections still come from
// `src/`, so the blog copy has a single source of truth.

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// Canonical origin of the static deployment. The CloudFront hostname is
// stable for this distribution, so every canonical URL, sitemap entry and RSS
// link points at the deployment that actually serves these pages.
export const STATIC_SITE_URL = 'https://d2eip6kpluaijf.cloudfront.net';

// https://astro.build/config
export default defineConfig({
	site: STATIC_SITE_URL,
	srcDir: './src-static',
	outDir: './dist-static',
	integrations: [mdx(), sitemap()],
	fonts: [
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
	output: 'static',
	build: {
		// `/about/` and `/blog/<slug>/` become real directories with an
		// `index.html`, which is what the existing CloudFront rewrite function
		// expects from the S3 origin.
		format: 'directory',
	},
});
