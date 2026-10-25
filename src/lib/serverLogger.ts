import { getRequestContext } from './requestContext';

/**
 * One structured log record per line. CloudWatch Logs Insights queries these
 * fields directly, and the metric filter in the CDK stack matches
 * `{ $.level = "error" }`, so the `level` values and the field names are part
 * of the observability contract and must not change without updating the filter
 * and docs/adr/0009-cloudwatch-observability.md.
 */
interface StructuredLog {
  level: 'info' | 'warn' | 'error';
  timestamp: string;
  event: string;
  // Request correlation, present only when the record is written while a
  // request is being served.
  requestId?: string;
  method?: string;
  path?: string;
  // Access-record fields.
  status?: number;
  durationMs?: number;
  // Error-record fields.
  errorName?: string;
  code?: string;
}

// A client-supplied path can be long enough to bloat every log line (ALB and
// CloudFront accept multi-kilobyte URIs). Keep the diagnosable prefix.
const maxLoggedPathLength = 512;

function write(level: StructuredLog['level'], record: StructuredLog): void {
  // Access records go to stdout and errors to stderr, mirroring conventional
  // process logging. The awslogs driver forwards both containers streams to the
  // same log stream, so correlation does not depend on which one is used.
  const line = `${JSON.stringify(record)}\n`;
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

function requestFields(): Pick<StructuredLog, 'requestId' | 'method' | 'path'> {
  const context = getRequestContext();
  if (!context) return {};
  return {
    requestId: context.requestId,
    method: context.method,
    path: truncatePath(context.path),
  };
}

function truncatePath(path: string): string {
  return path.length > maxLoggedPathLength
    ? `${path.slice(0, maxLoggedPathLength)}...`
    : path;
}

/**
 * Records one completed HTTP request. `level` is `warn` for a 4xx or 5xx
 * response and `info` otherwise, deliberately not `error`: server-side
 * exceptions already produce their own `level: "error"` record, and counting
 * both would double the StructuredErrorCount metric for a single failure.
 */
export function logRequest(record: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}): void {
  const level: StructuredLog['level'] = record.status >= 400 ? 'warn' : 'info';
  write(level, {
    level,
    timestamp: new Date().toISOString(),
    event: 'http.request',
    requestId: record.requestId,
    method: record.method,
    path: truncatePath(record.path),
    status: record.status,
    durationMs: Math.max(0, Math.round(record.durationMs)),
  });
}

/**
 * Records a server-side failure without leaking its message, stack, query text,
 * or parameters. Request correlation is attached automatically when the caller
 * runs inside a request (middleware, an API route, or a page), so the access
 * record for the same `requestId` shows the route, method, status, and latency.
 */
export function logServerError(event: string, error?: unknown): void {
  const record: StructuredLog = {
    level: 'error',
    timestamp: new Date().toISOString(),
    event,
    errorName: getErrorName(error),
    ...requestFields(),
  };
  const code = getErrorCode(error);
  if (code) record.code = code;

  write('error', record);
}

function getErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'Error';
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    ? error.code
    : undefined;
}
