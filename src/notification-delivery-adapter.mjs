import { NotificationDeliveryError } from "./notification-worker.mjs";

const notificationCopy = Object.freeze({
  intake_submitted: {
    subject: "Intake submitted",
    body: notification => `A governed intake is ready for triage. Project: ${notification.payload?.projectId || notification.relatedEntityId}.`
  },
  adoption_acknowledged: {
    subject: "Adoption acknowledged",
    body: notification => `The receiving owner acknowledged the adoption path. Project: ${notification.payload?.projectId || notification.relatedEntityId}.`
  },
  review_updated: {
    subject: "Review updated",
    body: notification => `A required review was updated to ${notification.payload?.status || "updated"}. Project: ${notification.payload?.projectId || notification.relatedEntityId}.`
  },
  decision_requested: {
    subject: "Decision requested",
    body: notification => `A governed decision is awaiting review. Project: ${notification.payload?.projectId || notification.relatedEntityId}. Outcome: ${notification.payload?.outcome || "requested"}.`
  },
  handoff_accepted: {
    subject: "Handoff accepted",
    body: notification => `The receiving owner accepted handoff. Project: ${notification.payload?.projectId || notification.relatedEntityId}.`
  },
  follow_up_scheduled: {
    subject: "Follow-up scheduled",
    body: notification => `A follow-up is scheduled for ${notification.payload?.scheduledFor || "the configured date"}. Project: ${notification.payload?.projectId || notification.relatedEntityId}.`
  }
});

export function renderNotificationTemplate(notification = {}) {
  const template = notificationCopy[notification.notificationType] || {
    subject: "Workflow notification",
    body: item => `A governed workflow event is ready. Related ${item.relatedEntityType}: ${item.relatedEntityId}.`
  };
  return {
    subject: template.subject,
    body: template.body(notification)
  };
}

export class EmailNotificationAdapter {
  constructor({ enabled = false, sendEmail, fromAddress = "dna-ai-labs@example.invalid" } = {}) {
    this.enabled = Boolean(enabled);
    this.sendEmail = sendEmail;
    this.fromAddress = fromAddress;
  }

  async send(notification, { idempotencyKey } = {}) {
    if (!this.enabled) throw new NotificationDeliveryError("NOTIFICATION_EMAIL_DISABLED");
    if (typeof this.sendEmail !== "function") throw new NotificationDeliveryError("NOTIFICATION_EMAIL_UNCONFIGURED");
    const message = renderNotificationTemplate(notification);
    return this.sendEmail({
      to: notification.recipientId,
      from: this.fromAddress,
      subject: message.subject,
      text: message.body,
      idempotencyKey
    });
  }
}

export class ChatNotificationAdapter {
  constructor({ enabled = false, sendChat } = {}) {
    this.enabled = Boolean(enabled);
    this.sendChat = sendChat;
  }

  async send(notification, { idempotencyKey } = {}) {
    if (!this.enabled) throw new NotificationDeliveryError("NOTIFICATION_CHAT_DISABLED");
    if (typeof this.sendChat !== "function") throw new NotificationDeliveryError("NOTIFICATION_CHAT_UNCONFIGURED");
    const message = renderNotificationTemplate(notification);
    return this.sendChat({
      recipientId: notification.recipientId,
      text: message.body,
      title: message.subject,
      idempotencyKey
    });
  }
}

export class FeatureFlaggedNotificationSender {
  constructor({ enabled = false, emailAdapter = new EmailNotificationAdapter(), chatAdapter = new ChatNotificationAdapter(), channels = ["email"] } = {}) {
    this.enabled = Boolean(enabled);
    this.emailAdapter = emailAdapter;
    this.chatAdapter = chatAdapter;
    this.channels = channels;
  }

  async send(notification, context = {}) {
    if (!this.enabled) throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_DISABLED");
    const sent = [];
    if (this.channels.includes("email")) {
      await this.emailAdapter.send(notification, context);
      sent.push("email");
    }
    if (this.channels.includes("chat")) {
      await this.chatAdapter.send(notification, context);
      sent.push("chat");
    }
    if (!sent.length) throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_DISABLED");
    return { channels: sent };
  }
}
