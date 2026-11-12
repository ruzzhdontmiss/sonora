/**
 * CSRF & Origin Validation Utility
 * Strictly validates that state-changing requests (POST, PUT, PATCH, DELETE)
 * originate from the expected host/origin, mitigating cross-site request forgery.
 */

export function validateRequestOrigin(request: Request): boolean {
  const method = request.method.toUpperCase();

  // Safe read-only HTTP methods do not change state
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return true;
  }

  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  const hostHeader = request.headers.get("host");

  // 1. If Origin header is present, it must match Host exactly
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader);
      return Boolean(hostHeader && originUrl.host === hostHeader);
    } catch {
      return false;
    }
  }

  // 2. If Origin is missing, verify Referer
  if (refererHeader) {
    try {
      const refererUrl = new URL(refererHeader);
      return Boolean(hostHeader && refererUrl.host === hostHeader);
    } catch {
      return false;
    }
  }

  // 3. If both Origin and Referer are missing:
  // If request carries ambient cookie credentials, reject immediately to prevent stripped-header CSRF.
  const hasCookie = Boolean(request.headers.get("cookie"));
  if (hasCookie) {
    return false;
  }

  // Non-cookie requests (e.g. automated API clients) must supply a valid Host header
  return Boolean(hostHeader);
}
