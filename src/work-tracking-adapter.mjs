import { WorkflowError } from "./workflow-policy.mjs";

const defaultTimeoutMs = 2000;
const allowedStatuses = new Set(["unknown", "not_started", "in_progress", "blocked", "done"]);

function unavailable(details) {
  return new WorkflowError("WORK_TRACKING_UNAVAILABLE", "The work-tracking integration is unavailable.", 503, details);
}

function timeout(operation, timeoutMs) {
  return new WorkflowError("WORK_TRACKING_TIMEOUT", "The work-tracking integration timed out.", 503, { operation, timeoutMs });
}

function withTimeout(work, timeoutMs, operation) {
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => setTimeout(() => reject(timeout(operation, timeoutMs)), timeoutMs))
  ]);
}

function normalizeOrigins(origins = []) {
  return new Set(origins.map(value => {
    const text = String(value ?? "").trim();
    const url = new URL(text);
    if (url.protocol !== "https:" || url.origin !== text) throw new TypeError("Approved work-tracking origins must be HTTPS origins.");
    return url.origin;
  }));
}

function parseApprovedUrl(value, origins) {
  const text = String(value ?? "").trim();
  let url;
  try { url = new URL(text); } catch { throw new WorkflowError("INVALID_WORK_ITEM_LINK", "Work item link must be a valid approved URL.", 422); }
  if (!origins.has(url.origin)) throw new WorkflowError("UNAPPROVED_WORK_ITEM_LINK", "Work item must link to an approved work-tracking system.", 422);
  return url;
}

function normalizeStatus(value) {
  const status = String(value ?? "unknown").trim() || "unknown";
  return allowedStatuses.has(status) ? status : "unknown";
}

function normalizeResult(result, { operation, approvedUrl = null } = {}) {
  if (!result || typeof result !== "object") throw unavailable({ operation });
  const provider = String(result.provider ?? "work_tracking").trim() || "work_tracking";
  const externalUrl = String(result.externalUrl ?? approvedUrl?.href ?? "").trim();
  const externalRef = String(result.externalRef ?? result.id ?? "").trim();
  if (!externalUrl && !externalRef) throw new WorkflowError("WORK_ITEM_NOT_VERIFIED", "Work item validation did not return an approved reference.", 422, { operation });
  return {
    provider,
    externalRef: externalRef || externalUrl,
    externalUrl: externalUrl || null,
    externalStatus: normalizeStatus(result.externalStatus ?? result.status),
    lastVerifiedAt: result.lastVerifiedAt || result.verifiedAt || new Date().toISOString()
  };
}

export class DisabledWorkTrackingAdapter {
  createOrLinkSync() { throw unavailable({ operation: "createOrLink" }); }
  refreshSync() { throw unavailable({ operation: "refresh" }); }
  async createOrLink() { throw unavailable({ operation: "createOrLink" }); }
  async refresh() { throw unavailable({ operation: "refresh" }); }
}

export class WorkTrackingAdapter {
  constructor({
    approvedOrigins = ["https://tracker.example"],
    createWorkItem,
    createWorkItemSync,
    linkWorkItem,
    linkWorkItemSync,
    refreshWorkItem,
    refreshWorkItemSync,
    timeoutMs = defaultTimeoutMs
  } = {}) {
    this.approvedOrigins = normalizeOrigins(approvedOrigins);
    this.provider = { createWorkItem, createWorkItemSync, linkWorkItem, linkWorkItemSync, refreshWorkItem, refreshWorkItemSync };
    this.timeoutMs = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 10000) : defaultTimeoutMs;
  }

  validateExternalUrl(value) {
    return parseApprovedUrl(value, this.approvedOrigins);
  }

  async createOrLink(input = {}, context = {}) {
    const externalUrl = String(input.externalUrl ?? input.workItemUrl ?? "").trim();
    const operation = externalUrl ? "linkWorkItem" : "createWorkItem";
    const provider = externalUrl ? this.provider.linkWorkItem : this.provider.createWorkItem;
    if (typeof provider !== "function") throw unavailable({ operation });
    const approvedUrl = externalUrl ? this.validateExternalUrl(externalUrl) : null;
    try {
      const result = await withTimeout(() => provider({ externalUrl: approvedUrl?.href || null, externalRef: input.externalRef || null, context }), this.timeoutMs, operation);
      return normalizeResult(result, { operation, approvedUrl });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw unavailable({ operation });
    }
  }

  createOrLinkSync(input = {}, context = {}) {
    const externalUrl = String(input.externalUrl ?? input.workItemUrl ?? "").trim();
    const operation = externalUrl ? "linkWorkItem" : "createWorkItem";
    const provider = externalUrl ? this.provider.linkWorkItemSync : this.provider.createWorkItemSync;
    if (typeof provider !== "function") throw unavailable({ operation, mode: "sync" });
    const approvedUrl = externalUrl ? this.validateExternalUrl(externalUrl) : null;
    try {
      const result = provider({ externalUrl: approvedUrl?.href || null, externalRef: input.externalRef || null, context });
      if (result && typeof result.then === "function") throw unavailable({ operation, mode: "sync" });
      return normalizeResult(result, { operation, approvedUrl });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw unavailable({ operation });
    }
  }

  async refresh(item = {}, context = {}) {
    if (typeof this.provider.refreshWorkItem !== "function") throw unavailable({ operation: "refreshWorkItem" });
    try {
      const result = await withTimeout(() => this.provider.refreshWorkItem({ item, context }), this.timeoutMs, "refreshWorkItem");
      return normalizeResult({ ...item, ...result }, { operation: "refreshWorkItem" });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw unavailable({ operation: "refreshWorkItem" });
    }
  }

  refreshSync(item = {}, context = {}) {
    if (typeof this.provider.refreshWorkItemSync !== "function") throw unavailable({ operation: "refreshWorkItem", mode: "sync" });
    try {
      const result = this.provider.refreshWorkItemSync({ item, context });
      if (result && typeof result.then === "function") throw unavailable({ operation: "refreshWorkItem", mode: "sync" });
      return normalizeResult({ ...item, ...result }, { operation: "refreshWorkItem" });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw unavailable({ operation: "refreshWorkItem" });
    }
  }
}
