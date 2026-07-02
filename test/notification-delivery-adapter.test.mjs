import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatNotificationAdapter,
  EmailNotificationAdapter,
  FeatureFlaggedNotificationSender,
  renderNotificationTemplate
} from "../src/notification-delivery-adapter.mjs";
import { NotificationDeliveryError } from "../src/notification-worker.mjs";

const notification = {
  id: "notification-1",
  recipientId: "lab-lead",
  notificationType: "decision_requested",
  relatedEntityType: "decision",
  relatedEntityId: "decision-1",
  payload: { projectId: "project-1", outcome: "Scale" }
};

test("notification templates render minimal metadata-only workflow messages", () => {
  const rendered = renderNotificationTemplate({
    ...notification,
    notificationType: "review_updated",
    payload: {
      projectId: "project-1",
      reviewType: "security",
      status: "complete",
      rationale: "Sensitive rationale should not be used",
      evidenceLink: "https://intranet.example/secret"
    }
  });

  assert.equal(rendered.subject, "Review updated");
  assert.match(rendered.body, /project-1/);
  assert.match(rendered.body, /complete/);
  assert.equal(rendered.body.includes("Sensitive rationale"), false);
  assert.equal(rendered.body.includes("https://intranet.example"), false);
  assert.equal(renderNotificationTemplate({ ...notification, notificationType: "follow_up_due", payload: { projectId: "project-1", dueOn: "2026-08-01" } }).subject, "Follow-up due");
});

test("email notification adapter is feature-gated and passes idempotency keys", async () => {
  await assert.rejects(
    () => new EmailNotificationAdapter({ enabled: false, sendEmail: async () => {} }).send(notification, { idempotencyKey: "notification:1" }),
    error => error instanceof NotificationDeliveryError && error.code === "NOTIFICATION_EMAIL_DISABLED"
  );
  await assert.rejects(
    () => new EmailNotificationAdapter({ enabled: true }).send(notification, { idempotencyKey: "notification:1" }),
    error => error instanceof NotificationDeliveryError && error.code === "NOTIFICATION_EMAIL_UNCONFIGURED"
  );

  const sent = [];
  const adapter = new EmailNotificationAdapter({
    enabled: true,
    fromAddress: "labs@example.invalid",
    sendEmail: async message => { sent.push(message); return { providerId: "email-1" }; }
  });
  await adapter.send(notification, { idempotencyKey: "notification:notification-1" });

  assert.equal(sent[0].to, "lab-lead");
  assert.equal(sent[0].from, "labs@example.invalid");
  assert.equal(sent[0].subject, "Decision requested");
  assert.equal(sent[0].idempotencyKey, "notification:notification-1");
  assert.equal(JSON.stringify(sent[0]).includes("rationale"), false);
});

test("chat notification adapter is feature-gated and sends minimal message text", async () => {
  await assert.rejects(
    () => new ChatNotificationAdapter({ enabled: false, sendChat: async () => {} }).send(notification, { idempotencyKey: "notification:1" }),
    error => error instanceof NotificationDeliveryError && error.code === "NOTIFICATION_CHAT_DISABLED"
  );
  await assert.rejects(
    () => new ChatNotificationAdapter({ enabled: true }).send(notification, { idempotencyKey: "notification:1" }),
    error => error instanceof NotificationDeliveryError && error.code === "NOTIFICATION_CHAT_UNCONFIGURED"
  );

  const sent = [];
  const adapter = new ChatNotificationAdapter({
    enabled: true,
    sendChat: async message => { sent.push(message); return { providerId: "chat-1" }; }
  });
  await adapter.send(notification, { idempotencyKey: "notification:notification-1" });

  assert.equal(sent[0].recipientId, "lab-lead");
  assert.equal(sent[0].title, "Decision requested");
  assert.match(sent[0].text, /project-1/);
  assert.equal(sent[0].idempotencyKey, "notification:notification-1");
});

test("feature-flagged notification sender routes only enabled channels", async () => {
  const sent = [];
  const sender = new FeatureFlaggedNotificationSender({
    enabled: true,
    channels: ["chat"],
    emailAdapter: new EmailNotificationAdapter({ enabled: true, sendEmail: async message => sent.push(["email", message]) }),
    chatAdapter: new ChatNotificationAdapter({ enabled: true, sendChat: async message => sent.push(["chat", message]) })
  });

  assert.deepEqual(await sender.send(notification, { idempotencyKey: "notification:notification-1" }), { channels: ["chat"] });
  assert.deepEqual(sent.map(([channel]) => channel), ["chat"]);

  await assert.rejects(
    () => new FeatureFlaggedNotificationSender({ enabled: false }).send(notification, { idempotencyKey: "notification:1" }),
    error => error instanceof NotificationDeliveryError && error.code === "NOTIFICATION_DELIVERY_DISABLED"
  );
});
