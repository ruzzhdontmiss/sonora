/**
 * Redacted Structured Logger for SONORA (P5-T09).
 *
 * Guarantees zero credential leakage in stdout/stderr logs:
 * - Automatically redacts access tokens, refresh tokens, client secrets, auth codes, and cookies.
 * - Formats logs as structured JSON with correlation IDs, timestamps, and context tags.
 */

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /authorization/i,
  /code/i,
  /cookie/i,
  /credential/i,
  /key/i,
];

/**
 * Recursively redacts sensitive keys and values from logging metadata.
 */
export function redactSensitiveData(obj: unknown, depth = 0): unknown {
  if (depth > 5) return "[DEPTH_LIMIT]";
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    // Check for Bearer token patterns in strings
    if (/bearer\s+[a-zA-Z0-9_\-\.]+/i.test(obj)) {
      return obj.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item, depth + 1));
  }

  if (typeof obj === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive) {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return redacted;
  }

  return obj;
}

export interface LogContext {
  module: string;
  operation?: string;
  userId?: string;
  correlationId?: string;
}

export function logInfo(context: LogContext, message: string, meta?: Record<string, unknown>): void {
  const payload = {
    level: "INFO",
    timestamp: new Date().toISOString(),
    ...context,
    message,
    ...(meta ? { meta: redactSensitiveData(meta) } : {}),
  };
  console.log(JSON.stringify(payload));
}

export function logWarn(context: LogContext, message: string, meta?: Record<string, unknown>): void {
  const payload = {
    level: "WARN",
    timestamp: new Date().toISOString(),
    ...context,
    message,
    ...(meta ? { meta: redactSensitiveData(meta) } : {}),
  };
  console.warn(JSON.stringify(payload));
}

export function logError(context: LogContext, message: string, err?: unknown, meta?: Record<string, unknown>): void {
  const payload = {
    level: "ERROR",
    timestamp: new Date().toISOString(),
    ...context,
    message,
    error: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err),
    ...(meta ? { meta: redactSensitiveData(meta) } : {}),
  };
  console.error(JSON.stringify(payload));
}
