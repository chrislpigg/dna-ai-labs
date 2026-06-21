import test from "node:test";
import assert from "node:assert/strict";
import { csrfCookieName, csrfHeaderName, parseCookies, requireCsrfProtection, responseSecurityHeaders } from "../src/request-security.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

const applicationOrigin = "https://labs.example";

function request({ method = "POST", origin = applicationOrigin, cookie = `${csrfCookieName}=csrf-token`, csrfToken = "csrf-token" } = {}) {
  return {
    method,
    headers: {
      origin,
      cookie,
      [csrfHeaderName]: csrfToken
    }
  };
}

function expectCsrfError(input, code) {
  assert.throws(() => requireCsrfProtection(input, { authenticationMode: "cookie", applicationOrigin }), error => error instanceof WorkflowError && error.code === code && error.status === 403);
}

test("cookie-authenticated mutations accept an exact same-origin CSRF token", () => {
  assert.doesNotThrow(() => requireCsrfProtection(request(), { authenticationMode: "cookie", applicationOrigin }));
});

test("cookie-authenticated mutations reject missing, mismatched, and cross-site CSRF requests", () => {
  expectCsrfError(request({ csrfToken: "" }), "CSRF_TOKEN_MISSING");
  expectCsrfError(request({ csrfToken: "different-token" }), "CSRF_TOKEN_INVALID");
  expectCsrfError(request({ origin: "https://attacker.example" }), "CSRF_ORIGIN_INVALID");
});

test("verified bearer mutations do not depend on cookies and safe requests skip CSRF validation", () => {
  assert.doesNotThrow(() => requireCsrfProtection(request({ cookie: "", csrfToken: "" }), { authenticationMode: "bearer", applicationOrigin }));
  assert.doesNotThrow(() => requireCsrfProtection(request({ method: "GET", cookie: "", csrfToken: "" }), { authenticationMode: "cookie", applicationOrigin }));
});

test("cookie parsing keeps the first token and all responses carry a non-weakened CSP", () => {
  assert.equal(parseCookies(`${csrfCookieName}=first; ${csrfCookieName}=second`).get(csrfCookieName), "first");
  assert.match(responseSecurityHeaders["content-security-policy"], /default-src 'self'/);
  assert.match(responseSecurityHeaders["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(responseSecurityHeaders["x-content-type-options"], "nosniff");
  assert.equal(responseSecurityHeaders["strict-transport-security"], "max-age=31536000; includeSubDomains");
});
