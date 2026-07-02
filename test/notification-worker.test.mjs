import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabsStore } from "../src/labs-store.mjs";
import { NotificationWorker } from "../src/notification-worker.mjs";

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-notifications-"));
  const store = new LabsStore(join(directory, "labs.sqlite"));
  return { store, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function insertNotification(store, id = "notification-1") {
  store.storage.insertNotificationOutbox({
    id,
    recipientId: "lab-lead",
    notificationType: "decision_requested",
    state: "pending",
    relatedEntityType: "decision",
    relatedEntityId: "decision-1",
    attemptCount: 0,
    payload: { projectId: "project-1", outcome: "Scale" },
    createdAt: "2026-07-02T00:00:00.000Z",
    availableAt: "2026-07-02T00:00:00.000Z",
    lastErrorCode: null
  });
}

test("notification worker retries with a stable idempotency key and does not redeliver sent rows", async () => {
  const { store, dispose } = createStore();
  try {
    insertNotification(store);
    const sent = [];
    let current = "2026-07-02T00:00:00.000Z";
    const sender = {
      async send(notification, { idempotencyKey }) {
        sent.push({ id: notification.id, idempotencyKey });
        if (sent.length === 1) {
          const error = new Error("provider token secret should not be stored");
          error.code = "provider token secret";
          throw error;
        }
      }
    };
    const worker = new NotificationWorker({
      storage: store.storage,
      sender,
      maxAttempts: 2,
      retryDelayMs: 1_000,
      now: () => new Date(current)
    });

    assert.deepEqual(await worker.runOnce({ limit: 1 }), { claimed: 1, sent: 0, failed: 1, deadLettered: 0 });
    let notification = store.notificationOutbox(store.actor("admin")).find(item => item.id === "notification-1");
    assert.equal(notification.state, "failed");
    assert.equal(notification.attemptCount, 1);
    assert.equal(notification.lastErrorCode, "NOTIFICATION_DELIVERY_FAILED");
    assert.equal(notification.idempotencyKey, "notification:notification-1");
    assert.equal(notification.availableAt, "2026-07-02T00:00:01.000Z");

    assert.deepEqual(await worker.runOnce({ limit: 1 }), { claimed: 0, sent: 0, failed: 0, deadLettered: 0 });
    assert.equal(sent.length, 1);

    current = "2026-07-02T00:00:02.000Z";
    assert.deepEqual(await worker.runOnce({ limit: 1 }), { claimed: 1, sent: 1, failed: 0, deadLettered: 0 });
    notification = store.notificationOutbox(store.actor("admin")).find(item => item.id === "notification-1");
    assert.equal(notification.state, "sent");
    assert.equal(notification.attemptCount, 2);
    assert.equal(notification.sentAt, "2026-07-02T00:00:02.000Z");
    assert.deepEqual(sent.map(item => item.idempotencyKey), ["notification:notification-1", "notification:notification-1"]);

    assert.deepEqual(await worker.runOnce({ limit: 1 }), { claimed: 0, sent: 0, failed: 0, deadLettered: 0 });
    assert.equal(sent.length, 2);

    const audit = store.auditEvents(store.actor("admin"), 20);
    assert.equal(audit.some(event => event.action === "notification_delivery_failed" && event.after.errorCode === "NOTIFICATION_DELIVERY_FAILED"), true);
    assert.equal(audit.some(event => event.action === "notification_sent" && event.after.idempotencyKey === "notification:notification-1"), true);
    assert.equal(JSON.stringify(audit).includes("provider token secret"), false);
  } finally { dispose(); }
});

test("notification worker dead-letters after bounded retries", async () => {
  const { store, dispose } = createStore();
  try {
    insertNotification(store, "notification-dead");
    let current = "2026-07-02T00:00:00.000Z";
    const worker = new NotificationWorker({
      storage: store.storage,
      sender: { send: async () => { const error = new Error("temporary"); error.code = "SMTP_TIMEOUT"; throw error; } },
      maxAttempts: 2,
      retryDelayMs: 1_000,
      now: () => new Date(current)
    });

    assert.deepEqual(await worker.runOnce({ limit: 1 }), { claimed: 1, sent: 0, failed: 1, deadLettered: 0 });
    current = "2026-07-02T00:00:02.000Z";
    assert.deepEqual(await worker.runOnce({ limit: 1 }), { claimed: 1, sent: 0, failed: 0, deadLettered: 1 });

    const notification = store.notificationOutbox(store.actor("admin")).find(item => item.id === "notification-dead");
    assert.equal(notification.state, "dead_letter");
    assert.equal(notification.attemptCount, 2);
    assert.equal(notification.lastErrorCode, "SMTP_TIMEOUT");
    assert.equal(store.auditEvents(store.actor("admin"), 20).some(event => event.action === "notification_dead_lettered" && event.entityId === "notification-dead"), true);
  } finally { dispose(); }
});
