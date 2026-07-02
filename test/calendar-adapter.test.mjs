import test from "node:test";
import assert from "node:assert/strict";
import { CalendarAdapter } from "../src/calendar-adapter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

function workflowError(code) {
  return error => error instanceof WorkflowError && error.code === code;
}

test("calendar adapter creates scheduled event references through the configured provider", async () => {
  const adapter = new CalendarAdapter({
    createEvent: async ({ eventType, scheduledFor }) => ({
      provider: "calendar",
      externalRef: "event-1",
      externalUrl: "https://calendar.example/events/event-1",
      scheduledFor,
      lastVerifiedAt: "2026-07-02T00:00:00.000Z",
      eventType
    })
  });

  const event = await adapter.createOrValidate({ eventType: "decision_meeting", scheduledFor: "2026-07-10T16:00:00.000Z" });
  assert.equal(event.eventType, "decision_meeting");
  assert.equal(event.externalRef, "event-1");
  assert.equal(event.scheduledFor, "2026-07-10T16:00:00.000Z");
});

test("calendar adapter validates approved existing event links", async () => {
  const adapter = new CalendarAdapter({
    approvedOrigins: ["https://calendar.example"],
    validateEvent: async ({ externalUrl, scheduledFor }) => ({
      provider: "calendar",
      externalRef: "event-2",
      externalUrl,
      scheduledFor,
      lastVerifiedAt: "2026-07-02T00:05:00.000Z"
    })
  });

  const event = await adapter.createOrValidate({
    eventType: "follow_up",
    scheduledFor: "2026-08-01",
    externalUrl: "https://calendar.example/events/event-2"
  });
  assert.equal(event.externalUrl, "https://calendar.example/events/event-2");
  assert.equal(event.lastVerifiedAt, "2026-07-02T00:05:00.000Z");
});

test("calendar adapter rejects unapproved event links before provider validation", async () => {
  const adapter = new CalendarAdapter({
    approvedOrigins: ["https://calendar.example"],
    validateEvent: async () => assert.fail("provider must not receive unapproved calendar URL")
  });

  await assert.rejects(
    () => adapter.createOrValidate({ eventType: "decision_meeting", scheduledFor: "2026-07-10", externalUrl: "https://external.example/events/1" }),
    workflowError("UNAPPROVED_CALENDAR_EVENT_LINK")
  );
});

test("calendar adapter fails closed on provider failure and timeout", async () => {
  const unavailable = new CalendarAdapter({
    createEvent: async () => { throw new Error("calendar secret"); }
  });
  await assert.rejects(
    () => unavailable.createOrValidate({ eventType: "decision_meeting", scheduledFor: "2026-07-10" }),
    workflowError("CALENDAR_UNAVAILABLE")
  );

  const timeout = new CalendarAdapter({
    timeoutMs: 5,
    validateEvent: () => new Promise(resolve => setTimeout(() => resolve({ externalRef: "event-1" }), 50))
  });
  await assert.rejects(
    () => timeout.createOrValidate({ eventType: "follow_up", scheduledFor: "2026-08-01", externalUrl: "https://calendar.example/events/1" }),
    workflowError("CALENDAR_TIMEOUT")
  );
});
