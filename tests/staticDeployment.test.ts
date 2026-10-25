import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(name: string): string {
	return readFileSync(resolve(projectRoot, name), 'utf8').replace(/\r\n/g, '\n');
}

const staticConfig = read('astro.config.static.mjs');
const ssrConfig = read('astro.config.mjs');
const packageJson = JSON.parse(read('package.json')) as {
	scripts: Record<string, string>;
};
const staticWorkflow = read('.github/workflows/deploy-static.yml');

describe('static build configuration', () => {
	it('renders to plain HTML without an adapter or a server entry point', () => {
		expect(staticConfig).toContain("output: 'static'");
		expect(staticConfig).not.toContain('@astrojs/node');
		expect(staticConfig).not.toMatch(/^\s*adapter:/m);
	});

	it('uses the static entry directory and its own output directory', () => {
		expect(staticConfig).toContain("srcDir: './src-static'");
		expect(staticConfig).toContain("outDir: './dist-static'");
	});

	it('sets the canonical origin to the static CloudFront distribution', () => {
		expect(staticConfig).toContain("'https://d2eip6kpluaijf.cloudfront.net'");
		expect(staticConfig).not.toContain('example.com');
	});

	it('leaves the server-rendered build configuration untouched', () => {
		expect(ssrConfig).toContain("output: 'server'");
		expect(ssrConfig).toContain("node({ mode: 'standalone' })");
	});

	it('exposes dedicated build and type-check scripts', () => {
		expect(packageJson.scripts['build:static']).toBe(
			'astro build --config astro.config.static.mjs',
		);
		expect(packageJson.scripts['check:static']).toBe(
			'astro check --config astro.config.static.mjs',
		);
		expect(packageJson.scripts.build).toBe('astro build');
	});

	it('keeps the static artifact out of version control', () => {
		expect(read('.gitignore')).toContain('dist-static/');
	});
});

describe('static entry points', () => {
	const pages = [
		'src-static/pages/index.astro',
		'src-static/pages/about.astro',
		'src-static/pages/blog/index.astro',
		'src-static/pages/blog/[...slug].astro',
		'src-static/pages/404.astro',
		'src-static/pages/rss.xml.js',
	];

	it('defines only the public blog routes', () => {
		for (const page of pages) {
			expect(existsSync(resolve(projectRoot, page))).toBe(true);
		}

		const staticEntries = readdirSync(resolve(projectRoot, 'src-static/pages'));
		expect(staticEntries).not.toContain('api');
		expect(staticEntries).not.toContain('dashboard.astro');
	});

	it('pre-renders one page per article instead of resolving it at request time', () => {
		const route = read('src-static/pages/blog/[...slug].astro');
		expect(route).toContain('export async function getStaticPaths');
		expect(route).toContain('getCollection');
		expect(route).toContain('render(post)');
		expect(route).not.toContain('Astro.response');
	});

	it('reuses the shared content collections', () => {
		expect(read('src-static/content.config.ts')).toContain(
			"export { collections } from '../src/content.config'",
		);
	});
});

describe('blog content', () => {
	const blogDir = resolve(projectRoot, 'src/content/blog');
	const articles = readdirSync(blogDir).filter((name) => /\.mdx?$/.test(name));

	it('contains at least four original articles', () => {
		expect(articles.length).toBeGreaterThanOrEqual(4);
	});

	it('gives every article complete metadata', () => {
		for (const article of articles) {
			const source = read(`src/content/blog/${article}`);
			expect(source).toMatch(
				/^---\ntitle: .+\ndescription: .+\npubDate: .+\nauthor: ["']?unibudget-team["']?/m,
			);
			expect(source).not.toMatch(/lorem ipsum/i);
			expect(source).not.toMatch(/example\.com/);
		}
	});

	it('publishes under the UniBudget author rather than the template author', () => {
		expect(existsSync(resolve(projectRoot, 'src/content/authors/unibudget-team.md'))).toBe(true);
		expect(existsSync(resolve(projectRoot, 'src/content/authors/alex-johnson.md'))).toBe(false);
	});

	it('removes the default Astro tutorial articles', () => {
		for (const template of ['first-post.md', 'second-post.md', 'third-post.md', 'markdown-style-guide.md', 'using-mdx.mdx']) {
			expect(existsSync(resolve(projectRoot, 'src/content/blog', template))).toBe(false);
		}
	});
});

describe('static deployment workflow', () => {
	it('builds with the static configuration only', () => {
		expect(staticWorkflow).toContain('npm run build:static');
		expect(staticWorkflow).toContain('node scripts/verifyStaticBuild.mjs');
		expect(staticWorkflow).not.toContain('npm run build ');
	});

	it('installs reproducibly and runs the checks before deploying', () => {
		expect(staticWorkflow).toContain('run: npm ci');
		expect(staticWorkflow).toContain('npm run check:static');
		expect(staticWorkflow).toContain('npm test -- --run');

		const testsIndex = staticWorkflow.indexOf('Run Tests');
		const uploadIndex = staticWorkflow.indexOf('Upload Static Build');
		expect(testsIndex).toBeGreaterThan(-1);
		expect(testsIndex).toBeLessThan(uploadIndex);
	});

	it('uses GitHub OIDC instead of long-lived access keys', () => {
		expect(staticWorkflow).toContain('id-token: write');
		expect(staticWorkflow).toContain('aws-actions/configure-aws-credentials@v4');
		expect(staticWorkflow).toContain('role-to-assume: ${{ env.AWS_DEPLOY_ROLE_ARN }}');
		expect(staticWorkflow).not.toContain('AWS_ACCESS_KEY_ID');
		expect(staticWorkflow).not.toContain('AWS_SECRET_ACCESS_KEY');
		expect(staticWorkflow).not.toContain('aws configure');
	});

	it('targets only the verified static bucket and distribution', () => {
		expect(staticWorkflow).toContain('STATIC_BUCKET: staticsitestack-sitebucket397a1860-33rkrycbsdvl');
		expect(staticWorkflow).toContain('STATIC_DISTRIBUTION_ID: E2JVO3G1WG2Q2T');
		expect(staticWorkflow).toContain('STATIC_SITE_URL: https://d2eip6kpluaijf.cloudfront.net');
		expect(staticWorkflow).toContain('SSR_DISTRIBUTION_ID: E30KFH719MS9Z0');
		expect(staticWorkflow).toContain('must never target the SSR distribution');
	});

	it('never deletes objects during the upload', () => {
		expect(staticWorkflow).not.toContain('--delete');
		expect(staticWorkflow).not.toContain('delete-objects');
		expect(staticWorkflow).toContain('Non-destructive upload');
	});

	it('waits for the CloudFront invalidation and verifies the live site', () => {
		const invalidationIndex = staticWorkflow.indexOf('create-invalidation');
		const waitIndex = staticWorkflow.indexOf('wait invalidation-completed');
		const verifyIndex = staticWorkflow.indexOf('Verify Live Static Site');

		expect(invalidationIndex).toBeGreaterThan(-1);
		expect(invalidationIndex).toBeLessThan(waitIndex);
		expect(waitIndex).toBeLessThan(verifyIndex);
		expect(staticWorkflow).toContain('node scripts/verifyStaticSite.mjs "$STATIC_SITE_URL"');
	});

	it('does not deploy or modify the server-rendered application', () => {
		for (const forbidden of ['cdk deploy', 'cdk bootstrap', 'cdk destroy', 'aws ecs', 'ecs update-service', 'ApplicationTask', 'migrate.mjs']) {
			expect(staticWorkflow).not.toContain(forbidden);
		}
	});

	it('only runs for changes that can affect the static site', () => {
		expect(staticWorkflow).toContain("branches: [main]");
		expect(staticWorkflow).toContain("'src-static/**'");
		expect(staticWorkflow).toContain("'astro.config.static.mjs'");
		expect(staticWorkflow).toContain('workflow_dispatch:');
	});
});
