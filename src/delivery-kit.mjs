import { WorkflowError } from "./workflow-policy.mjs";

export const deliveryKitItemKeys = Object.freeze([
  "architecture",
  "evaluation",
  "operating_model",
  "onboarding",
  "support",
  "cost",
  "monitoring",
  "rollback"
]);

export const deliveryKitStatuses = Object.freeze(["not_started", "in_progress", "complete"]);

export function defaultDeliveryKitItems(projectId, rows = []) {
  const byKey = new Map(rows.map(item => [item.itemKey, item]));
  return deliveryKitItemKeys.map(itemKey => byKey.get(itemKey) || {
    projectId,
    itemKey,
    status: "not_started",
    ownerId: null,
    evidenceLink: null,
    acceptedAt: null,
    acceptedBy: null,
    updatedAt: null,
    updatedBy: null
  });
}

export function normalizeDeliveryKitItemKey(value) {
  const itemKey = String(value ?? "").trim();
  if (!deliveryKitItemKeys.includes(itemKey)) throw new WorkflowError("INVALID_DELIVERY_KIT_ITEM", "Delivery-kit item is not recognized.", 422);
  return itemKey;
}

export function normalizeDeliveryKitInput(input = {}) {
  const status = String(input.status ?? "").trim();
  if (!deliveryKitStatuses.includes(status)) throw new WorkflowError("INVALID_DELIVERY_KIT_STATUS", "Delivery-kit status is invalid.", 422);
  const ownerId = String(input.ownerId ?? "").trim();
  if (!ownerId) throw new WorkflowError("MISSING_DELIVERY_KIT_OWNER", "Delivery-kit items require an accountable owner.", 422);
  const evidenceLink = String(input.evidenceLink ?? "").trim() || null;
  if (status === "complete" && !evidenceLink) throw new WorkflowError("MISSING_DELIVERY_KIT_EVIDENCE", "Completed delivery-kit items require an approved evidence link.", 422);
  return { status, ownerId, evidenceLink };
}
