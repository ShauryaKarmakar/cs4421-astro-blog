export interface Credentials {
  email: string;
  password: string;
}

type CredentialsValidation =
  | { valid: true; value: Credentials }
  | { valid: false; error: string };

/**
 * Maximum byte length allowed for bcrypt inputs during registration.
 * Bcrypt truncates password inputs beyond 72 bytes.
 */
export const MAX_REGISTRATION_PASSWORD_BYTES = 72;

/**
 * Upper safety limit for credentials inputs on any endpoint to prevent
 * memory or event-loop denial of service attacks before hashing.
 * Kept generous (4096 bytes) to preserve login compatibility for any existing accounts.
 */
export const MAX_PASSWORD_INPUT_BYTES = 4096;
export const MAX_EMAIL_INPUT_CHARS = 254;

export function parseCredentials(input: unknown): CredentialsValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, error: 'Request body must be a JSON object.' };
  }

  const body = input as Record<string, unknown>;
  if (
    typeof body.email !== 'string' ||
    body.email.trim().length === 0 ||
    typeof body.password !== 'string' ||
    body.password.length === 0
  ) {
    return { valid: false, error: 'Email and password are required.' };
  }

  if (body.email.length > MAX_EMAIL_INPUT_CHARS) {
    return { valid: false, error: 'Email address is too long.' };
  }

  if (Buffer.byteLength(body.password, 'utf8') > MAX_PASSWORD_INPUT_BYTES) {
    return { valid: false, error: 'Password exceeds maximum allowed length.' };
  }

  return {
    valid: true,
    value: { email: body.email, password: body.password },
  };
}
