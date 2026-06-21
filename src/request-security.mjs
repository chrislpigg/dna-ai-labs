import { timingSafeEqual } from "node:crypto";
import { WorkflowError } from "./workflow-policy.mjs";

export const csrfCookieName = "__Host-labs-csrf";
export const csrfHeaderName = "x-labs-csrf-token";

export const responseSecurityHeaders = Object.freeze({
  "content-security-policy": "default-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff"
});

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function header(request, name) {
  const value = request?.headers?.[name];
  return typeof value === "string" ? value : "";
}

function validHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

function equalToken(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(value) {
  const cookies = new Map();
  if (typeof value !== "string") return cookies;
  for (const pair of value.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const token = pair.slice(separator + 1).trim();
    if (name && token && !cookies.has(name)) cookies.set(name, token);
  }
  return cookies;
}

/**
 * Enforces CSRF only for a future cookie-session transport. Bearer tokens are
 * caller-supplied authorization headers, so browsers do not attach them to a
 * cross-site request and this check is intentionally not applied to them.
 */
export function requireCsrfProtection(request, { authenticationMode, applicationOrigin } = {}) {
  if (!mutatingMethods.has(String(request?.method || "").toUpperCase()) || authenticationMode !== "cookie") return;
  if (!validHttpsOrigin(applicationOrigin)) {
    throw new WorkflowError("CSRF_CONFIGURATION_INVALID", "Cookie-authenticated requests are not available because CSRF protection is not configured.", 503);
  }

  const origin = header(request, "origin");
  if (origin !== applicationOrigin) {
    throw new WorkflowError("CSRF_ORIGIN_INVALID", "The request origin is not accepted.", 403);
  }

  const token = parseCookies(header(request, "cookie")).get(csrfCookieName);
  const submitted = header(request, csrfHeaderName);
  if (!token || !submitted) {
    throw new WorkflowError("CSRF_TOKEN_MISSING", "A CSRF token is required for this request.", 403);
  }
  if (!equalToken(token, submitted)) {
    throw new WorkflowError("CSRF_TOKEN_INVALID", "The CSRF token is not valid.", 403);
  }
}
