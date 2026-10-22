interface ServerErrorLog {
  level: 'error';
  event: string;
  errorName: string;
  code?: string;
}

export function logServerError(event: string, error?: unknown): void {
  const log: ServerErrorLog = {
    level: 'error',
    event,
    errorName: getErrorName(error),
  };
  const code = getErrorCode(error);
  if (code) log.code = code;

  process.stderr.write(`${JSON.stringify(log)}\n`);
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
