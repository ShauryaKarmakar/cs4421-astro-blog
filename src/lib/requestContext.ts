import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields every log line written while serving a request can carry, so an error
 * record can be correlated with the access record for the same request. The
 * path is the URL pathname only: query strings can contain tokens or filters
 * and are never recorded.
 */
export interface RequestLogContext {
  requestId: string;
  method: string;
  path: string;
}

// AsyncLocalStorage rather than a module-level variable: a single Node process
// serves concurrent requests, so per-request state must follow the async call
// chain and not be shared between them.
const storage = new AsyncLocalStorage<RequestLogContext>();

export function runWithRequestContext<T>(
  context: RequestLogContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestLogContext | undefined {
  return storage.getStore();
}
