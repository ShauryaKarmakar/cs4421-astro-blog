#!/usr/bin/env node
// Guards the static deployment artifact before anything is uploaded.
//
// The blog must remain a genuinely static site: real HTML files for every
// route, no server entry point, no API handlers. This script fails the
// deployment when the output is incomplete or when the SSR build has somehow
// leaked into `dist-static`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const outDir = join(root, 'dist-static');
const contentDir = join(root, 'src', 'content', 'blog');
const site = 'https://d2eip6kpluaijf.cloudfront.net';
const minimumArticles = 4;

const failures = [];

function fail(message) {
	console.error(`::error::${message}`);
	failures.push(message);
}

function walk(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? walk(path) : [path];
	});
}

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
	console.error('dist-static is missing. Run `npm run build:static` first.');
	process.exit(1);
}

const files = walk(outDir)
	.map((file) => relative(outDir, file).split(sep).join('/'))
	.sort();
const read = (file) => readFileSync(join(outDir, file), 'utf8');

const requiredPages = [
	'index.html',
	'about/index.html',
	'blog/index.html',
	'404.html',
	'rss.xml',
	'sitemap-index.xml',
	'sitemap-0.xml',
];
for (const page of requiredPages) {
	if (!files.includes(page)) {
		fail(`The static build is missing ${page}.`);
	}
}

const articles = existsSync(contentDir)
	? walk(contentDir)
			.filter((file) => /\.(md|mdx)$/i.test(file))
			.map((file) => relative(contentDir, file).split(sep).join('/').replace(/\.(md|mdx)$/i, ''))
			.sort()
	: [];

if (articles.length < minimumArticles) {
	fail(`Expected at least ${minimumArticles} blog articles, found ${articles.length}.`);
}

const blogIndex = files.includes('blog/index.html') ? read('blog/index.html') : '';
const rss = files.includes('rss.xml') ? read('rss.xml') : '';
const sitemap = files.includes('sitemap-0.xml') ? read('sitemap-0.xml') : '';

for (const slug of articles) {
	const page = `blog/${slug}/index.html`;
	if (!files.includes(page)) {
		fail(`Missing pre-rendered article page ${page}.`);
		continue;
	}

	const html = read(page);
	if (!/<h1[\s>]/.test(html)) {
		fail(`${page} does not contain a heading, so the article body did not render.`);
	}
	if (!blogIndex.includes(`href="/blog/${slug}/"`)) {
		fail(`The blog index does not link to /blog/${slug}/.`);
	}
	if (!rss.includes(`${site}/blog/${slug}/`)) {
		fail(`The RSS feed does not include ${slug}.`);
	}
	if (!sitemap.includes(`${site}/blog/${slug}/`)) {
		fail(`The sitemap does not include ${slug}.`);
	}
}

// A server bundle or an API directory in the artifact would mean the SSR
// project was built instead of the static entry point.
if (existsSync(join(outDir, 'server'))) {
	fail('dist-static/server exists; this artifact must not contain the SSR server build.');
}
if (existsSync(join(outDir, 'entry.mjs'))) {
	fail('dist-static/entry.mjs exists; this artifact must not contain a server entry point.');
}
for (const file of files) {
	if (file.endsWith('.mjs') || file.endsWith('.cjs')) {
		fail(`dist-static contains server-side module ${file}.`);
	}
	if (file === 'api' || file.startsWith('api/') || file.includes('/api/')) {
		fail(`dist-static contains API route output ${file}.`);
	}
}

if (files.includes('index.html')) {
	const home = read('index.html');
	if (!home.includes(`<link rel="canonical" href="${site}/">`)) {
		fail(`The homepage canonical URL is not ${site}/.`);
	}
	if (!home.includes('UniBudget')) {
		fail('The homepage does not identify UniBudget.');
	}
}

const textual = files.filter((file) => file.endsWith('.html') || file.endsWith('.xml'));
for (const file of textual) {
	if (read(file).includes('example.com')) {
		fail(`${file} still references example.com; canonical and feed URLs must use the static hostname.`);
	}
}

if (files.includes('404.html')) {
	const notFound = read('404.html');
	if (!notFound.includes('href="/blog/"')) {
		fail('404.html has no way back into the site.');
	}
}

console.log(
	`Static build contains ${files.length} files: ${requiredPages.length} required routes, ${articles.length} article pages.`,
);
console.log('No server bundle, API routes or example.com references were found.');

if (failures.length > 0) {
	console.error(`Static build verification failed with ${failures.length} problem(s).`);
	process.exit(1);
}

console.log(`Static build verified for ${site}.`);
