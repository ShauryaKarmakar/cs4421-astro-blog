#!/usr/bin/env node
// Verifies the deployed static blog, not just the upload.
//
// Run after the CloudFront invalidation has completed:
//
//   node scripts/verifyStaticSite.mjs https://d2eip6kpluaijf.cloudfront.net
//
// Every article that exists in the content collection must be reachable
// directly, unknown paths must return a real HTML 404, and the delivery
// configuration must enforce HTTPS.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const baseUrl = process.argv[2] ?? process.env.STATIC_SITE_URL ?? 'https://d2eip6kpluaijf.cloudfront.net';
const base = new URL(baseUrl);
const contentDir = join(process.cwd(), 'src', 'content', 'blog');
const cacheBuster = String(Date.now());

const failures = [];
let checks = 0;

function check(condition, message) {
	checks += 1;
	if (condition) {
		console.log(`  ok   ${message}`);
		return true;
	}
	console.error(`  FAIL ${message}`);
	failures.push(message);
	return false;
}

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

function frontmatter(path) {
	const source = readFileSync(path, 'utf8');
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const data = {};
	for (const line of match[1].split(/\r?\n/)) {
		const field = line.match(/^([A-Za-z_]+):\s*(.*)$/);
		if (!field) continue;
		data[field[1]] = field[2].replace(/^['"]|['"]$/g, '');
	}
	return data;
}

async function request(pathname, { followRedirect = false } = {}) {
	const url = new URL(pathname, base);
	url.searchParams.set('verify', cacheBuster);
	const response = await fetch(url, {
		redirect: followRedirect ? 'follow' : 'manual',
		headers: { 'cache-control': 'no-cache' },
	});
	const body = await response.text();
	return { response, body, url };
}

const articles = walk(contentDir)
	.filter((file) => /\.(md|mdx)$/i.test(file))
	.map((file) => {
		const slug = relative(contentDir, file).split(sep).join('/').replace(/\.(md|mdx)$/i, '');
		return { slug, ...frontmatter(file) };
	})
	.sort((a, b) => a.slug.localeCompare(b.slug));

console.log(`Verifying ${base.href} (${articles.length} articles)`);

// Homepage
{
	const { response, body } = await request('/');
	const contentType = response.headers.get('content-type') ?? '';
	check(response.status === 200, `GET / returns 200 (got ${response.status})`);
	check(contentType.includes('text/html'), `GET / is served as HTML (got ${contentType || 'no content type'})`);
	check(body.includes('UniBudget'), 'The homepage identifies UniBudget');
	check(body.includes(`<link rel="canonical" href="${base.origin}/">`), 'The homepage canonical URL uses the deployment hostname');
	check(!body.includes('example.com'), 'The homepage has no example.com references');
	const cacheControl = response.headers.get('cache-control') ?? '';
	check(/must-revalidate|max-age=0/.test(cacheControl), `HTML is revalidated rather than cached for a day (${cacheControl || 'no cache-control'})`);
}

// Static pages and feeds
for (const pathname of ['/about/', '/blog/', '/rss.xml', '/sitemap-index.xml', '/sitemap-0.xml', '/favicon.svg']) {
	const { response } = await request(pathname);
	check(response.status === 200, `GET ${pathname} returns 200 (got ${response.status})`);
}

// Every article must open directly, with its own title
{
	const index = await request('/blog/');
	check(index.response.status === 200, 'The blog index is reachable');
	for (const article of articles) {
		if (!check(index.body.includes(`href="/blog/${article.slug}/"`), `The blog index links to /blog/${article.slug}/`)) {
			continue;
		}
		const { response, body } = await request(`/blog/${article.slug}/`);
		check(response.status === 200, `GET /blog/${article.slug}/ returns 200 (got ${response.status})`);
		if (article.title) {
			check(body.includes(article.title), `/blog/${article.slug}/ renders its title`);
		}
	}
}

// Hashed assets must be cacheable for a year
{
	const { body } = await request('/');
	const asset = body.match(/\/_astro\/[^"']+\.css/)?.[0];
	if (check(Boolean(asset), 'The homepage references a bundled stylesheet')) {
		const { response } = await request(asset);
		const contentType = response.headers.get('content-type') ?? '';
		const cacheControl = response.headers.get('cache-control') ?? '';
		check(response.status === 200, `GET ${asset} returns 200 (got ${response.status})`);
		check(contentType.includes('text/css'), `${asset} is served as CSS (got ${contentType || 'no content type'})`);
		check(cacheControl.includes('immutable'), `${asset} is served with an immutable cache policy (${cacheControl || 'no cache-control'})`);
	}
}

// HTTP must redirect to HTTPS
{
	const httpUrl = new URL(base.pathname, base.href.replace(/^https:/, 'http:'));
	const response = await fetch(httpUrl, { redirect: 'manual' });
	const location = response.headers.get('location') ?? '';
	check([301, 302, 307, 308].includes(response.status), `HTTP requests redirect (got ${response.status})`);
	check(location.startsWith('https://'), `The redirect targets HTTPS (got ${location || 'no location'})`);
}

// Unknown paths must be a real, useful 404 page
for (const pathname of [`/verify-missing-${cacheBuster}/`, `/blog/verify-missing-${cacheBuster}/`]) {
	const { response, body } = await request(pathname);
	const contentType = response.headers.get('content-type') ?? '';
	check(response.status === 404, `GET ${pathname} returns 404 (got ${response.status})`);
	check(contentType.includes('text/html'), `${pathname} returns HTML for a missing page (got ${contentType || 'no content type'})`);
	check(body.includes('That page is not here'), `${pathname} renders the 404 page instead of S3 XML`);
	check(!body.includes('<Error><Code>'), `${pathname} does not expose the S3 AccessDenied document`);
}

if (failures.length > 0) {
	console.error(`\n${failures.length} of ${checks} checks failed for ${base.href}`);
	process.exit(1);
}

console.log(`\nAll ${checks} checks passed for ${base.href}`);
