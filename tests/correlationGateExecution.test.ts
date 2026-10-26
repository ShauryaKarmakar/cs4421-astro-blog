import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(
  resolve(projectRoot, '.github/workflows/deploy.yml'),
  'utf8',
).replace(/\r\n/g, '\n');

const bashAvailable = spawnSync('bash', ['--version']).status === 0;
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

/**
 * Extracts the shell body of the correlation step's `run: |` block, matching
 * the indentation the YAML block scalar uses.
 */
function correlationStepScript(): string {
  const lines = workflow.split('\n');
  const stepStart = lines.indexOf(
    '      - name: Verify Request Correlation Through CloudFront',
  );
  if (stepStart === -1) {
    throw new Error('The workflow has no request-correlation step.');
  }

  const runStart = lines.findIndex(
    (line, index) => index > stepStart && line === '        run: |',
  );
  if (runStart === -1) {
    throw new Error('The request-correlation step has no shell body.');
  }

  const body: string[] = [];
  for (let index = runStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    body.push(line.slice(10));
  }

  return body.join('\n');
}

/**
 * Stands in for curl so each header shape can be exercised without a network
 * call or a deployment. The real parsing and failure logic still runs.
 */
const curlStub = [
  'curl() {',
  '  case "${STUB_CASE:-ok}" in',
  '    missing)',
  "      printf 'HTTP/1.1 200 OK\\r\\ncontent-type: text/html\\r\\n\\r\\n'",
  '      ;;',
  '    blank)',
  "      printf 'HTTP/1.1 200 OK\\r\\nx-request-id:   \\r\\n\\r\\n'",
  '      ;;',
  '    malformed)',
  "      printf 'HTTP/1.1 200 OK\\r\\nx-request-id: ../../etc/passwd\\r\\n\\r\\n'",
  '      ;;',
  '    uppercase)',
  "      printf 'HTTP/1.1 200 OK\\r\\nX-Request-Id: 8f3c2a1e-4b6d-4f0a-9c3e-2d1b0a9f8e7d\\r\\n\\r\\n'",
  '      ;;',
  '    *)',
  "      printf 'HTTP/1.1 200 OK\\r\\nx-request-id: 8f3c2a1e-4b6d-4f0a-9c3e-2d1b0a9f8e7d\\r\\n\\r\\n'",
  '      ;;',
  '  esac',
  '}',
].join('\n');

const issuedRequestId = '8f3c2a1e-4b6d-4f0a-9c3e-2d1b0a9f8e7d';

interface GateRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCorrelationGate(
  stubCase: string,
  applicationUrl = 'https://d111111abcdef8.cloudfront.net',
): GateRun {
  const directory = mkdtempSync(join(tmpdir(), 'unibudget-correlation-gate-'));
  temporaryDirectories.push(directory);

  const scriptPath = join(directory, 'correlation-gate.sh');
  writeFileSync(
    scriptPath,
    `${curlStub}\n\n${correlationStepScript()}\n`,
  );

  const result = spawnSync('bash', [scriptPath.replace(/\\/g, '/')], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      STUB_CASE: stubCase,
      APPLICATION_URL: applicationUrl,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.skipIf(!bashAvailable)('request correlation gate execution', () => {
  it('passes when the login response carries a well-formed id', () => {
    const run = runCorrelationGate('ok');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('well-formed X-Request-Id');
  });

  it('accepts the header regardless of casing', () => {
    const run = runCorrelationGate('uppercase');

    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('well-formed X-Request-Id');
  });

  it('fails when the header is absent', () => {
    const run = runCorrelationGate('missing');

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(
      'did not return an X-Request-Id header through CloudFront',
    );
  });

  it('fails when the header is present but empty', () => {
    const run = runCorrelationGate('blank');

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(
      'did not return an X-Request-Id header through CloudFront',
    );
  });

  it('fails when the value does not match the middleware format', () => {
    const run = runCorrelationGate('malformed');

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('X-Request-Id header is malformed');
  });

  it('fails when the stack exposes no HTTPS CloudFront URL', () => {
    const run = runCorrelationGate('ok', 'http://example.test');

    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain(
      'did not provide an HTTPS CloudFront application URL',
    );
  });

  it('does not echo the correlation value or response body', () => {
    const run = runCorrelationGate('ok');

    expect(run.stdout).not.toContain(issuedRequestId);
    expect(run.stdout).not.toContain('content-type');
  });
});
