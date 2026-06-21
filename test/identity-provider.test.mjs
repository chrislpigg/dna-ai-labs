import test from "node:test";
import assert from "node:assert/strict";
import {
  createIdentityProvider,
  createTestIdentityProvider,
  DemoIdentityProvider,
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

function expectWorkflowError(fn, code) {
  assert.throws(fn, error => error instanceof WorkflowError && error.code === code);
}

test("the explicit demo identity adapter returns normalized verified identity metadata", () => {
  const provider = createIdentityProvider({ demoMode: true, demoIdentities: identities, demoDefaultSubject: "test-subject" });
  assert.ok(provider instanceof DemoIdentityProvider);
  assert.deepEqual(provider.authenticate({ headers: {} }), {
    subject: "test-subject",
    groups: ["lab-lead"],
    organization: "test-tenant",
    sessionExpiresAt: "2099-01-01T00:00:00.000Z"
  });
});

test("the test identity adapter is isolated from the production factory path", () => {
  const provider = createTestIdentityProvider(identities, { defaultSubject: "test-subject" });
  assert.equal(provider.authenticate({ headers: {} }).subject, "test-subject");
});

test("production identity handling rejects caller-supplied identity headers", () => {
  const provider = createIdentityProvider({ demoMode: false });
  assert.ok(provider instanceof RejectingIdentityProvider);
  expectWorkflowError(() => provider.authenticate({ headers: { "x-authenticated-user": "admin", "x-labs-actor": "admin" } }), "UNVERIFIED_IDENTITY");
});

test("identity adapters reject incomplete identity claims", () => {
  expectWorkflowError(() => createTestIdentityProvider({ incomplete: { groups: [], organization: "tenant" } }), "INVALID_VERIFIED_IDENTITY");
});
