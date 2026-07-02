const defaultNow = () => new Date();
const toIso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export class NotificationDeliveryError extends Error {
  constructor(code = "NOTIFICATION_DELIVERY_FAILED") {
    super("Notification delivery failed.");
    this.name = "NotificationDeliveryError";
    this.code = code;
  }
}

export class DisabledNotificationSender {
  async send() {
    throw new NotificationDeliveryError("NOTIFICATION_PROVIDER_UNCONFIGURED");
  }
}

export class MetadataOnlyNotificationSender {
  constructor({ records = [] } = {}) {
    this.records = records;
  }

  async send(notification, { idempotencyKey }) {
    this.records.push({
      id: notification.id,
      recipientId: notification.recipientId,
      notificationType: notification.notificationType,
      relatedEntityType: notification.relatedEntityType,
      relatedEntityId: notification.relatedEntityId,
      idempotencyKey
    });
    return { idempotencyKey };
  }
}

export function nonSensitiveDeliveryErrorCode(error) {
  const raw = String(error?.code || error?.name || "NOTIFICATION_DELIVERY_FAILED").trim().toUpperCase();
  const normalized = raw.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 64);
  if (!normalized || /(SECRET|TOKEN|PASSWORD|BEARER|API_KEY|AUTH)/.test(normalized)) return "NOTIFICATION_DELIVERY_FAILED";
  return normalized;
}

export class NotificationWorker {
  constructor({
    storage,
    sender = new DisabledNotificationSender(),
    workerId = "notification-worker",
    maxAttempts = 3,
    retryDelayMs = 60_000,
    leaseMs = 300_000,
    now = defaultNow
  } = {}) {
    if (!storage || typeof storage.transaction !== "function") throw new TypeError("Notification worker requires transactional storage.");
    if (!sender || typeof sender.send !== "function") throw new TypeError("Notification worker requires a sender with send().");
    this.storage = storage;
    this.sender = sender;
    this.workerId = String(workerId || "notification-worker");
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 3);
    this.retryDelayMs = Math.max(1, Number(retryDelayMs) || 60_000);
    this.leaseMs = Math.max(1, Number(leaseMs) || 300_000);
    this.now = now;
  }

  timestamp() {
    return toIso(this.now());
  }

  retryAvailableAt(attemptCount, timestamp) {
    const base = new Date(timestamp).getTime();
    const delay = this.retryDelayMs * (2 ** Math.max(0, attemptCount - 1));
    return new Date(base + delay).toISOString();
  }

  async runOnce({ limit = 25 } = {}) {
    const timestamp = this.timestamp();
    const claimExpiresAt = new Date(new Date(timestamp).getTime() + this.leaseMs).toISOString();
    const notifications = await this.storage.transaction(tx => tx.claimNotificationOutbox({
      limit,
      timestamp,
      workerId: this.workerId,
      claimExpiresAt
    }));
    const summary = { claimed: notifications.length, sent: 0, failed: 0, deadLettered: 0 };
    for (const notification of notifications) {
      const outcome = await this.deliver(notification);
      summary[outcome] += 1;
    }
    return summary;
  }

  async deliver(notification) {
    const timestamp = this.timestamp();
    const nextAttemptCount = Number(notification.attemptCount || 0) + 1;
    try {
      await this.sender.send(notification, { idempotencyKey: notification.idempotencyKey });
      await this.storage.transaction(async tx => {
        await tx.markNotificationSent(notification.id, nextAttemptCount, timestamp);
        await tx.appendAudit(notification.recipientId, "notification_sent", "notification_outbox", notification.id, {
          state: notification.state,
          attemptCount: notification.attemptCount
        }, {
          state: "sent",
          attemptCount: nextAttemptCount,
          idempotencyKey: notification.idempotencyKey
        });
      });
      return "sent";
    } catch (error) {
      const errorCode = nonSensitiveDeliveryErrorCode(error);
      if (nextAttemptCount >= this.maxAttempts) {
        await this.storage.transaction(async tx => {
          await tx.markNotificationDeadLetter(notification.id, nextAttemptCount, errorCode, timestamp);
          await tx.appendAudit(notification.recipientId, "notification_dead_lettered", "notification_outbox", notification.id, {
            state: notification.state,
            attemptCount: notification.attemptCount
          }, {
            state: "dead_letter",
            attemptCount: nextAttemptCount,
            errorCode
          });
        });
        return "deadLettered";
      }
      const availableAt = this.retryAvailableAt(nextAttemptCount, timestamp);
      await this.storage.transaction(async tx => {
        await tx.markNotificationFailed(notification.id, nextAttemptCount, errorCode, availableAt);
        await tx.appendAudit(notification.recipientId, "notification_delivery_failed", "notification_outbox", notification.id, {
          state: notification.state,
          attemptCount: notification.attemptCount
        }, {
          state: "failed",
          attemptCount: nextAttemptCount,
          errorCode,
          availableAt
        });
      });
      return "failed";
    }
  }
}
