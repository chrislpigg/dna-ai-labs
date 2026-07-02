import test from "node:test";
import assert from "node:assert/strict";
import { ArtifactVerifier } from "../src/artifact-verifier.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

function assertWorkflowError(error, code) {
  return error instanceof WorkflowError && error.code === code;
}

test("artifact verifier preserves approved-origin validation and records allow-list verification", async () => {
  const verifier = new ArtifactVerifier({ approvedOrigins: ["https://docs.example"] });
  const result = await verifier.verifyLink("https://docs.example/artifacts/123");

  assert.equal(result.status, "verified");
  assert.equal(result.method, "allow_list");
  assert.equal(result.origin, "https://docs.example");
  assert.match(result.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("artifact verifier rejects unapproved origins before provider validation", async () => {
  const verifier = new ArtifactVerifier({
    approvedOrigins: ["https://docs.example"],
    verifyRecord: () => assert.fail("provider must not receive an unapproved URL")
  });

  await assert.rejects(
    () => verifier.verifyLink("https://external.example/artifacts/123"),
    error => assertWorkflowError(error, "UNAPPROVED_EVIDENCE_LINK")
  );
});

test("artifact verifier fails closed when provider record validation fails", async () => {
  const verifier = new ArtifactVerifier({
    approvedOrigins: ["https://docs.example"],
    verifyRecord: async () => ({ status: "failed", reasonCode: "record_not_found" })
  });

  await assert.rejects(
    () => verifier.verifyLink("https://docs.example/artifacts/missing"),
    error => assertWorkflowError(error, "ARTIFACT_VERIFICATION_FAILED")
  );
});

test("artifact verifier times out slow provider record validation", async () => {
  const verifier = new ArtifactVerifier({
    approvedOrigins: ["https://docs.example"],
    timeoutMs: 5,
    verifyRecord: () => new Promise(resolve => setTimeout(() => resolve(true), 50))
  });

  await assert.rejects(
    () => verifier.verifyLink("https://docs.example/artifacts/slow"),
    error => assertWorkflowError(error, "ARTIFACT_VERIFICATION_TIMEOUT")
  );
});
