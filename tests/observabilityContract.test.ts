import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '../src/lib/requestContext';
import { logRequest, logServerError } from '../src/lib/serverLogger';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function read(name: string): string {
	return readFileSync(resolve(projectRoot, name), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The fields the application is allowed to emit. This is the contract the
 * CloudWatch metric filter and every documented Logs Insights query depend on;
 * a query naming a field that is never written silently returns nothing.
 */
const schemaFields = new Set([
	'@timestamp',
	'@logStream',
	'level',
	'timestamp',
	'event',
	'requestId',
	'method',
	'path',
	'status',
	'durationMs',
	'errorName',
	'code',
]);

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
	stdout = [];
	stderr = [];
	vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
		stdout.push(String(chunk));
		return true;
	}) as never);
	vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	}) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function records(chunks: string[]): Array<Record<string, unknown>> {
	return chunks
		.join('')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('metric filter and log schema contract', () => {
	it('defines the filter as a top-level JSON level match on the application log group', () => {
		const stack = read('hello-cdk/lib/monitoring-stack.ts');

		expect(stack).toContain(
			"filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error')",
		);
		expect(stack).toContain("metricNamespace: 'UniBudget/Application'");
		expect(stack).toContain("metricName: 'StructuredErrorCount'");
		expect(stack).toContain('DEFAULT_LOG_GROUP_NAME = \'/unibudget/ecs/application\'');
	});

	it('emits error records that the deployed filter matches', () => {
		runWithRequestContext(
			{ requestId: 'contract-request-id', method: 'GET', path: '/api/health' },
			() => logServerError('health.database.failed', Object.assign(new Error('boom'), { code: '08006' })),
		);

		const [record] = records(stderr);
		// This is exactly what `{ $.level = "error" }` evaluates.
		expect(record.level).toBe('error');
		expect(record.requestId).toBe('contract-request-id');
		expect(record.code).toBe('08006');
		expect(record.errorName).toBe('Error');
		expect(stdout).toEqual([]);
		for (const key of Object.keys(record)) {
			expect(schemaFields.has(key)).toBe(true);
		}
	});

	it('never counts a 5xx access record as a structured error', () => {
		logRequest({
			requestId: 'contract-request-id',
			method: 'GET',
			path: '/dashboard',
			status: 500,
			durationMs: 12,
		});

		const [record] = records(stdout);
		expect(record.event).toBe('http.request');
		expect(record.level).toBe('warn');
		expect(record.level).not.toBe('error');
		expect(record.status).toBe(500);
		for (const key of Object.keys(record)) {
			expect(schemaFields.has(key)).toBe(true);
		}
	});
});

describe('documented Logs Insights queries', () => {
	it('only reference fields the application actually emits', () => {
		const runbook = read('docs/logging.md');
		const fieldLists = [...runbook.matchAll(/fields\s+([^\n]+)/g)]
			.map((match) => match[1].split('|')[0])
			.map((list) => list.replace(/\\/g, '').trim())
			.filter((list) => list.length > 0);

		expect(fieldLists.length).toBeGreaterThan(5);

		const unknown = new Set<string>();
		for (const list of fieldLists) {
			for (const field of list.split(',').map((entry) => entry.trim())) {
				if (!schemaFields.has(field)) {
					unknown.add(field);
				}
			}
		}

		expect([...unknown]).toEqual([]);
	});

	it('documents the four deployed alarm names', () => {
		for (const name of [
			'UniBudgetStack-Monitoring-Target5xx',
			'UniBudgetStack-Monitoring-UnhealthyTargets',
			'UniBudgetStack-Monitoring-LiveTaskCount',
			'UniBudgetStack-Monitoring-StructuredErrors',
		]) {
			expect(read('docs/chaos-drill.md')).toContain(name);
			expect(read('docs/alarms.md')).toContain(name);
		}
	});
});

describe('deployment correlation gate', () => {
	it('fails the release when the response loses its request id', () => {
		const workflow = read('.github/workflows/deploy.yml');

		expect(workflow).toContain(
			'awk \'tolower($1) == "x-request-id:" {print $2}\'',
		);
		expect(workflow).toContain(
			'The application did not return a correlatable X-Request-Id header through CloudFront.',
		);
		const gateIndex = workflow.indexOf('x-request-id:');
		const verifyStepIndex = workflow.indexOf('      - name: Verify Application Health Through CloudFront');
		expect(verifyStepIndex).toBeGreaterThan(-1);
		expect(gateIndex).toBeGreaterThan(verifyStepIndex);
	});
});
