import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  createIdentityProvider,
  createTestIdentityProvider,
  DemoIdentityProvider,
  OidcIdentityProvider,
  RejectingIdentityProvider
} from "../src/identity-provider.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

const identities = {
  "test-subject": {
    groups: ["lab-lead", "lab-lead"],
    organization: "test-tenant",
    sessionExpiresAt: "2099-01-01T00:00:00.000Z"
  }
};

const issuer = "https://identity.example";
const audience = "dna-ai-labs";
const tenantClaim = "organization_id";
const now = Date.parse("2026-06-20T12:00:00.000Z");

async function expectWorkflowError(promise, code, status = 401) {
  await assert.rejects(promise, error => error instanceof WorkflowError && error.code === code && error.status === status);
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function createOidcFixture() {
  const pair = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = { ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key", use: "sig", alg: "RS256" };
  const fetchCalls = [];
  const provider = new OidcIdentityProvider({
    issuer,
    audience,
    tenantClaim,
    jwksUri: `${issuer}/keys`,
    now: () => now,
    fetchImpl: async url => {
      fetchCalls.push(url);
      return { ok: true, json: async () => ({ keys: [publicJwk] }) };
    }
  });
  const token = async (claims = {}, header = { alg: "RS256", kid: "test-key" }) => {
    const encodedHeader = encode(header);
    const encodedPayload = encode({
      iss: issuer,
      aud: audience,
      sub: "test-subject",
      groups: ["lab-lead"],
      [tenantClaim]: "test-tenant",
      exp: Math.floor(now / 1000) + 3600,
      ...claims
    });
    const signature = await webcrypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
    return `${encodedHeader}.${encodedPayload}.${Buffer.from(signature).toString("base64url")}`;
  };
  return { provider, token, fetchCalls };
}

test("the explicit demo identity adapter returns normalized verified identity metadata", async () => {
  const provider = createIdentityProvider({ demoMode: true, demoIdentities: identities, demoDefaultSubject: "test-subject" });
  assert.ok(provider instanceof DemoIdentityProvider);
  assert.deepEqual(await provider.authenticate({ headers: {} }), {
    subject: "test-subject",
    groups: ["lab-lead"],
    organization: "test-tenant",
    sessionExpiresAt: "2099-01-01T00:00:00.000Z"
  });
});

test("the test identity adapter is isolated from the production factory path", async () => {
  const provider = createTestIdentityProvider(identities, { defaultSubject: "test-subject" });
  assert.equal((await provider.authenticate({ headers: {} })).subject, "test-subject");
});

test("production identity handling rejects caller-supplied identity headers without verified OIDC configuration", async () => {
  const provider = createIdentityProvider({ demoMode: false });
  assert.ok(provider instanceof RejectingIdentityProvider);
  await expectWorkflowError(provider.authenticate({ headers: { "x-authenticated-user": "admin", "x-labs-actor": "admin" } }), "UNVERIFIED_IDENTITY");
});

test("identity adapters reject incomplete identity claims", () => {
  assert.throws(() => createTestIdentityProvider({ incomplete: { groups: [], organization: "tenant" } }), error => error instanceof WorkflowError && error.code === "INVALID_VERIFIED_IDENTITY");
});

test("OIDC identity verification accepts a valid issuer, audience, expiry, and JWKS signature", async () => {
  const { provider, token, fetchCalls } = await createOidcFixture();
  const identity = await provider.authenticate({ headers: { authorization: `Bearer ${await token()}` } });
  assert.deepEqual(identity, {
    subject: "test-subject",
    groups: ["lab-lead"],
    organization: "test-tenant",
    sessionExpiresAt: "2026-06-20T13:00:00.000Z"
  });
  assert.deepEqual(fetchCalls, [`${issuer}/keys`]);
});

test("OIDC identity verification rejects malformed, expired, wrong-issuer, and wrong-audience bearer tokens", async () => {
  const { provider, token } = await createOidcFixture();
  const malformedToken = `${encode({ alg: "RS256", kid: "test-key" })}.not-json.${encode({ signature: "not-a-signature" })}`;
  await expectWorkflowError(provider.authenticate({ headers: { authorization: `Bearer ${malformedToken}` } }), "MALFORMED_BEARER_TOKEN");
  await expectWorkflowError(provider.authenticate({ headers: { authorization: `Bearer ${await token({ exp: Math.floor(now / 1000) })}` } }), "EXPIRED_BEARER_TOKEN");
  await expectWorkflowError(provider.authenticate({ headers: { authorization: `Bearer ${await token({ iss: "https://wrong-issuer.example" })}` } }), "INVALID_TOKEN_ISSUER");
  await expectWorkflowError(provider.authenticate({ headers: { authorization: `Bearer ${await token({ aud: "wrong-audience" })}` } }), "INVALID_TOKEN_AUDIENCE");
});

test("OIDC identity verification rejects a token whose signature does not match the configured JWKS", async () => {
  const { provider, token } = await createOidcFixture();
  const signed = await token();
  const [header, payload, signature] = signed.split(".");
  const tampered = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await expectWorkflowError(provider.authenticate({ headers: { authorization: `Bearer ${tampered}` } }), "INVALID_BEARER_SIGNATURE");
});
