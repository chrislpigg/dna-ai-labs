import { WorkflowError } from "./workflow-policy.mjs";

const defaultTimeoutMs = 2000;
const eventTypes = new Set(["decision_meeting", "follow_up"]);

function unavailable(details) {
  return new WorkflowError("CALENDAR_UNAVAILABLE", "The calendar integration is unavailable.", 503, details);
}

function withTimeout(work, timeoutMs, operation) {
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => setTimeout(() => reject(new WorkflowError("CALENDAR_TIMEOUT", "The calendar integration timed out.", 503, { operation, timeoutMs })), timeoutMs))
  ]);
}

function normalizeOrigins(origins = []) {
  return new Set(origins.map(value => {
    const text = String(value ?? "").trim();
    const url = new URL(text);
    if (url.protocol !== "https:" || url.origin !== text) throw new TypeError("Approved calendar origins must be HTTPS origins.");
    return url.origin;
  }));
}

function parseApprovedUrl(value, origins) {
  const text = String(value ?? "").trim();
  let url;
  try { url = new URL(text); } catch { throw new WorkflowError("INVALID_CALENDAR_EVENT_LINK", "Calendar event link must be a valid approved URL.", 422); }
  if (!origins.has(url.origin)) throw new WorkflowError("UNAPPROVED_CALENDAR_EVENT_LINK", "Calendar event must link to an approved calendar system.", 422);
  return url;
}

function normalizeEventType(value) {
  const eventType = String(value ?? "").trim();
  if (!eventTypes.has(eventType)) throw new WorkflowError("INVALID_CALENDAR_EVENT_TYPE", "Calendar event type is invalid.", 422);
  return eventType;
}

function normalizeResult(result, { operation, approvedUrl, eventType, scheduledFor }) {
  if (!result || typeof result !== "object") throw unavailable({ operation });
  const provider = String(result.provider ?? "calendar").trim() || "calendar";
  const externalUrl = String(result.externalUrl ?? approvedUrl?.href ?? "").trim();
  const externalRef = String(result.externalRef ?? result.id ?? "").trim();
  if (!externalUrl && !externalRef) throw new WorkflowError("CALENDAR_EVENT_NOT_VERIFIED", "Calendar validation did not return an approved event reference.", 422, { operation });
  return {
    eventType,
    provider,
    externalRef: externalRef || externalUrl,
    externalUrl: externalUrl || null,
    scheduledFor: result.scheduledFor || scheduledFor,
    lastVerifiedAt: result.lastVerifiedAt || result.verifiedAt || new Date().toISOString()
  };
}

export class DisabledCalendarAdapter {
  createOrValidateSync() { throw unavailable({ operation: "createOrValidate" }); }
  async createOrValidate() { throw unavailable({ operation: "createOrValidate" }); }
}

export class CalendarAdapter {
  constructor({ approvedOrigins = ["https://calendar.example"], createEvent, createEventSync, validateEvent, validateEventSync, timeoutMs = defaultTimeoutMs } = {}) {
    this.approvedOrigins = normalizeOrigins(approvedOrigins);
    this.provider = { createEvent, createEventSync, validateEvent, validateEventSync };
    this.timeoutMs = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 10000) : defaultTimeoutMs;
  }

  validateEventUrl(value) {
    return parseApprovedUrl(value, this.approvedOrigins);
  }

  async createOrValidate(input = {}, context = {}) {
    const eventType = normalizeEventType(input.eventType);
    const scheduledFor = String(input.scheduledFor ?? "").trim();
    const externalUrl = String(input.externalUrl ?? input.eventUrl ?? "").trim();
    const operation = externalUrl ? "validateEvent" : "createEvent";
    const provider = externalUrl ? this.provider.validateEvent : this.provider.createEvent;
    if (typeof provider !== "function") throw unavailable({ operation });
    const approvedUrl = externalUrl ? this.validateEventUrl(externalUrl) : null;
    try {
      const result = await withTimeout(() => provider({ eventType, scheduledFor, externalUrl: approvedUrl?.href || null, context }), this.timeoutMs, operation);
      return normalizeResult(result, { operation, approvedUrl, eventType, scheduledFor });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw unavailable({ operation });
    }
  }

  createOrValidateSync(input = {}, context = {}) {
    const eventType = normalizeEventType(input.eventType);
    const scheduledFor = String(input.scheduledFor ?? "").trim();
    const externalUrl = String(input.externalUrl ?? input.eventUrl ?? "").trim();
    const operation = externalUrl ? "validateEvent" : "createEvent";
    const provider = externalUrl ? this.provider.validateEventSync : this.provider.createEventSync;
    if (typeof provider !== "function") throw unavailable({ operation, mode: "sync" });
    const approvedUrl = externalUrl ? this.validateEventUrl(externalUrl) : null;
    try {
      const result = provider({ eventType, scheduledFor, externalUrl: approvedUrl?.href || null, context });
      if (result && typeof result.then === "function") throw unavailable({ operation, mode: "sync" });
      return normalizeResult(result, { operation, approvedUrl, eventType, scheduledFor });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw unavailable({ operation });
    }
  }
}
