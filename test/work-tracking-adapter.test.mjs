import test from "node:test";
import assert from "node:assert/strict";
import { WorkTrackingAdapter } from "../src/work-tracking-adapter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

function workflowError(code) {
  return error => error instanceof WorkflowError && error.code === code;
}

test("work-tracking adapter links approved work items and exposes verified status metadata", async () => {
  const adapter = new WorkTrackingAdapter({
    approvedOrigins: ["https://tracker.example"],
    linkWorkItem: async ({ externalUrl }) => ({
      provider: "tracker",
      externalRef: "WORK-123",
      externalUrl,
      externalStatus: "in_progress",
      lastVerifiedAt: "2026-07-02T00:00:00.000Z"
    })
  });

  const item = await adapter.createOrLink({ externalUrl: "https://tracker.example/browse/WORK-123" });
  assert.deepEqual(item, {
    provider: "tracker",
    externalRef: "WORK-123",
    externalUrl: "https://tracker.example/browse/WORK-123",
    externalStatus: "in_progress",
    lastVerifiedAt: "2026-07-02T00:00:00.000Z"
  });
});

test("work-tracking adapter creates work items only through the configured provider", async () => {
  const adapter = new WorkTrackingAdapter({
    createWorkItem: async () => ({ provider: "tracker", externalRef: "WORK-124", externalStatus: "not_started" })
  });

  const item = await adapter.createOrLink();
  assert.equal(item.externalRef, "WORK-124");
  assert.equal(item.externalStatus, "not_started");
  assert.match(item.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("work-tracking adapter rejects unapproved links before provider validation", async () => {
  const adapter = new WorkTrackingAdapter({
    approvedOrigins: ["https://tracker.example"],
    linkWorkItem: async () => assert.fail("provider must not receive an unapproved URL")
  });

  await assert.rejects(
    () => adapter.createOrLink({ externalUrl: "https://external.example/browse/WORK-123" }),
    workflowError("UNAPPROVED_WORK_ITEM_LINK")
  );
});

test("work-tracking adapter fails closed on provider failure and timeout", async () => {
  const unavailable = new WorkTrackingAdapter({
    createWorkItem: async () => { throw new Error("provider secret"); }
  });
  await assert.rejects(() => unavailable.createOrLink(), workflowError("WORK_TRACKING_UNAVAILABLE"));

  const timeout = new WorkTrackingAdapter({
    timeoutMs: 5,
    refreshWorkItem: () => new Promise(resolve => setTimeout(() => resolve({ externalStatus: "done" }), 50))
  });
  await assert.rejects(
    () => timeout.refresh({ provider: "tracker", externalRef: "WORK-123", externalStatus: "in_progress" }),
    workflowError("WORK_TRACKING_TIMEOUT")
  );
});
