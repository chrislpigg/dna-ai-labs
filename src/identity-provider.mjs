import { webcrypto } from "node:crypto";
import { WorkflowError } from "./workflow-policy.mjs";

const encoder = new TextEncoder();
const supportedAlgorithms = Object.freeze({
  RS256: { importAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAlgorithm: { name: "RSASSA-PKCS1-v1_5" }, keyType: "RSA" },
  ES256: { importAlgorithm: { name: "ECDSA", namedCurve: "P-256" }, verifyAlgorithm: { name: "ECDSA", hash: "SHA-256" }, keyType: "EC" }
});

function nonEmptyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function secureUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function immutableIdentity(identity) {
  const subject = nonEmptyText(identity?.subject);
  const organization = nonEmptyText(identity?.organization);
  const sessionExpiresAt = nonEmptyText(identity?.sessionExpiresAt);
  const groups = Array.isArray(identity?.groups)
    ? [...new Set(identity.groups.map(nonEmptyText).filter(Boolean))]
    : [];

  if (!subject || !organization || !sessionExpiresAt || Number.isNaN(Date.parse(sessionExpiresAt))) {
    throw new WorkflowError("INVALID_VERIFIED_IDENTITY", "The identity provider returned an invalid verified identity.", 401);
  }

  return Object.freeze({ subject, groups: Object.freeze(groups), organization, sessionExpiresAt });
}

function unauthenticated(code, message) {
  return new WorkflowError(code, message, 401);
}

function parseJsonSegment(segment) {
  if (typeof segment !== "string" || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw unauthenticated("MALFORMED_BEARER_TOKEN", "The bearer token is malformed.");
  }
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object.");
    return value;
  } catch {
    throw unauthenticated("MALFORMED_BEARER_TOKEN", "The bearer token is malformed.");
  }
}

function bearerToken(request) {
  const authorization = request?.headers?.authorization;
  const match = typeof authorization === "string" && authorization.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
  if (!match) throw unauthenticated("MISSING_BEARER_TOKEN", "A valid bearer token is required.");
  return match[1];
}

function base64urlBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw unauthenticated("MALFORMED_BEARER_TOKEN", "The bearer token is malformed.");
  }
  return Buffer.from(value, "base64url");
}

function audienceMatches(audience, expectedAudience) {
  return typeof audience === "string"
    ? audience === expectedAudience
    : Array.isArray(audience) && audience.some(value => value === expectedAudience);
}

function tokenIdentity(payload, { issuer, audience, tenantClaim, now }) {
  if (payload.iss !== issuer) throw unauthenticated("INVALID_TOKEN_ISSUER", "The bearer token issuer is not accepted.");
  if (!audienceMatches(payload.aud, audience)) throw unauthenticated("INVALID_TOKEN_AUDIENCE", "The bearer token audience is not accepted.");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(now() / 1000)) {
    throw unauthenticated("EXPIRED_BEARER_TOKEN", "The bearer token has expired.");
  }

  return immutableIdentity({
    subject: payload.sub,
    groups: payload.groups,
    organization: payload[tenantClaim],
    sessionExpiresAt: new Date(payload.exp * 1000).toISOString()
  });
}

/**
 * Server-side identity-provider contract. Implementations must return only
 * identities they have verified, never claims copied from caller-controlled
 * request headers.
 */
export class IdentityProvider {
  authenticationMode = "bearer";

  async authenticate(_request) {
    throw new Error("IdentityProvider implementations must implement authenticate().");
  }
}

/**
 * Seeded identity adapter for explicit demo mode and focused tests. It is not
 * available from the production factory path.
 */
export class DemoIdentityProvider extends IdentityProvider {
  authenticationMode = "demo";

  constructor(identities, { defaultSubject } = {}) {
    super();
    this.identities = new Map(Object.entries(identities || {}).map(([subject, identity]) => [subject, immutableIdentity({ ...identity, subject })]));
    this.defaultSubject = nonEmptyText(defaultSubject);
  }

  async authenticate(request) {
    const subject = nonEmptyText(request?.headers?.["x-labs-actor"]) || this.defaultSubject;
    const identity = this.identities.get(subject);
    if (!identity) throw new WorkflowError("UNAUTHENTICATED", "A valid demo identity is required.", 401);
    return identity;
  }
}

/**
 * Fail-closed placeholder for production until a verified token adapter is
 * configured. In particular, identity proxy headers are never trusted here.
 */
export class RejectingIdentityProvider extends IdentityProvider {
  authenticationMode = "bearer";

  async authenticate(_request) {
    throw new WorkflowError("UNVERIFIED_IDENTITY", "The production identity provider must verify the request before identity claims can be used.", 401);
  }
}

/**
 * OIDC bearer-token verifier. It uses only configured issuer, audience, and
 * JWKS URL values; it never accepts identity headers or records token text.
 */
export class OidcIdentityProvider extends IdentityProvider {
  authenticationMode = "bearer";

  constructor({ issuer, audience, jwksUri, tenantClaim, fetchImpl = globalThis.fetch, now = Date.now, jwksCacheTtlMs = 300_000 } = {}) {
    super();
    this.issuer = nonEmptyText(issuer);
    this.audience = nonEmptyText(audience);
    this.jwksUri = nonEmptyText(jwksUri);
    this.tenantClaim = nonEmptyText(tenantClaim);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.jwksCacheTtlMs = jwksCacheTtlMs;
    this.jwks = null;
    this.jwksExpiresAt = 0;
    if (!secureUrl(this.issuer) || !this.audience || !secureUrl(this.jwksUri) || !this.tenantClaim || typeof this.fetchImpl !== "function") {
      throw new Error("OIDC bearer-token verification requires issuer, audience, JWKS URL, tenant claim, and fetch implementation.");
    }
  }

  async loadJwks(force = false) {
    if (!force && this.jwks && this.jwksExpiresAt > this.now()) return this.jwks;
    try {
      const response = await this.fetchImpl(this.jwksUri);
      if (!response?.ok || typeof response.json !== "function") throw new Error("JWKS request failed.");
      const document = await response.json();
      if (!document || !Array.isArray(document.keys)) throw new Error("JWKS payload is invalid.");
      this.jwks = document.keys;
      this.jwksExpiresAt = this.now() + this.jwksCacheTtlMs;
      return this.jwks;
    } catch {
      throw new WorkflowError("OIDC_KEYSET_UNAVAILABLE", "The identity provider key set is unavailable.", 503);
    }
  }

  async keyFor(header) {
    const algorithm = supportedAlgorithms[header.alg];
    if (!algorithm || typeof header.kid !== "string" || !header.kid) {
      throw unauthenticated("MALFORMED_BEARER_TOKEN", "The bearer token is malformed.");
    }

    let keys = await this.loadJwks();
    let key = keys.find(candidate => candidate?.kid === header.kid);
    if (!key) {
      keys = await this.loadJwks(true);
      key = keys.find(candidate => candidate?.kid === header.kid);
    }
    if (!key || key.kty !== algorithm.keyType || (key.alg && key.alg !== header.alg) || (key.use && key.use !== "sig") || (Array.isArray(key.key_ops) && !key.key_ops.includes("verify"))) {
      throw unauthenticated("INVALID_BEARER_SIGNATURE", "The bearer token signature is not valid.");
    }

    try {
      return { algorithm, key: await webcrypto.subtle.importKey("jwk", key, algorithm.importAlgorithm, false, ["verify"]) };
    } catch {
      throw unauthenticated("INVALID_BEARER_SIGNATURE", "The bearer token signature is not valid.");
    }
  }

  async authenticate(request) {
    const token = bearerToken(request);
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = parseJsonSegment(encodedHeader);
    const payload = parseJsonSegment(encodedPayload);
    const { algorithm, key } = await this.keyFor(header);
    let valid = false;
    try {
      valid = await webcrypto.subtle.verify(algorithm.verifyAlgorithm, key, base64urlBytes(encodedSignature), encoder.encode(`${encodedHeader}.${encodedPayload}`));
    } catch {
      valid = false;
    }
    if (!valid) throw unauthenticated("INVALID_BEARER_SIGNATURE", "The bearer token signature is not valid.");
    return tokenIdentity(payload, this);
  }
}

export function createIdentityProvider({ demoMode, demoIdentities, demoDefaultSubject, issuer, audience, jwksUri, tenantClaim, fetchImpl, now } = {}) {
  if (demoMode === true) {
    return new DemoIdentityProvider(demoIdentities, { defaultSubject: demoDefaultSubject });
  }
  if (issuer && audience && jwksUri && tenantClaim) {
    return new OidcIdentityProvider({ issuer, audience, jwksUri, tenantClaim, fetchImpl, now });
  }
  return new RejectingIdentityProvider();
}

export function createTestIdentityProvider(identities, options = {}) {
  return new DemoIdentityProvider(identities, options);
}
