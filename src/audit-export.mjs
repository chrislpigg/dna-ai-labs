import { randomUUID } from "node:crypto";
import { WorkflowError } from "./workflow-policy.mjs";

export const auditExportColumns = Object.freeze([
  "export_id", "generated_at", "from", "to", "event_id", "event_created_at",
  "actor_id", "action", "entity_type", "entity_id", "before_summary", "after_summary"
]);

function parseBound(value, label, dateOnlySuffix) {
  const text = String(value ?? "").trim();
  if (!text) throw new WorkflowError("INVALID_AUDIT_EXPORT_BOUNDS", `${label} is required.`, 422);
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}${dateOnlySuffix}` : text;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new WorkflowError("INVALID_AUDIT_EXPORT_BOUNDS", `${label} must be a valid date or timestamp.`, 422);
  return date.toISOString();
}

export function normalizeAuditExportInput(input = {}) {
  const from = parseBound(input.from ?? input.fromDate ?? input.start ?? input.startDate, "Audit export from date", "T00:00:00.000Z");
  const to = parseBound(input.to ?? input.toDate ?? input.end ?? input.endDate, "Audit export to date", "T23:59:59.999Z");
  if (new Date(from) > new Date(to)) throw new WorkflowError("INVALID_AUDIT_EXPORT_BOUNDS", "Audit export from date must be before or equal to the to date.", 422);
  const requestedLimit = Number(input.limit ?? 1000);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 5000) : 1000;
  return { from, to, limit };
}

export function auditEventWithinBounds(event, bounds) {
  const createdAt = new Date(event.createdAt).getTime();
  return !Number.isNaN(createdAt) && createdAt >= new Date(bounds.from).getTime() && createdAt <= new Date(bounds.to).getTime();
}

export function csvCell(value) {
  const raw = value === null || value === undefined ? "" : (typeof value === "object" ? JSON.stringify(value) : String(value));
  const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function auditEventsToCsv(events, metadata) {
  const rows = [auditExportColumns];
  for (const event of events) {
    rows.push([
      metadata.exportId,
      metadata.generatedAt,
      metadata.from,
      metadata.to,
      event.id,
      event.createdAt,
      event.actorId,
      event.action,
      event.entityType,
      event.entityId,
      event.before ?? null,
      event.after ?? null
    ]);
  }
  return rows.map(row => row.map(csvCell).join(",")).join("\n");
}

export function buildAuditExport(events, { bounds, generatedAt = new Date().toISOString(), exportId = randomUUID(), organizationId = null } = {}) {
  const metadata = {
    exportId,
    generatedAt,
    from: bounds.from,
    to: bounds.to,
    count: events.length,
    limit: bounds.limit,
    format: "csv",
    organizationId
  };
  return { metadata, csv: auditEventsToCsv(events, metadata) };
}
