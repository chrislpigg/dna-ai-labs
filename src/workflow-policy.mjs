export const roles = Object.freeze({
  EMPLOYEE: "employee",
  SUBMITTER: "submitter",
  PROJECT_LEAD: "project-lead",
  FELLOW: "fellow",
  RECEIVING_OWNER: "receiving-owner",
  STEERING_REVIEWER: "steering-reviewer",
  LAB_LEAD: "lab-lead",
  EXECUTIVE_SPONSOR: "executive-sponsor",
  PLATFORM_REVIEWER: "platform-reviewer",
  ADMIN: "admin"
});

export const stages = Object.freeze({
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  TRIAGE: "Triage",
  SELECTED: "Selected",
  INCUBATING: "Incubating",
  DECISION_PENDING: "Decision pending",
  OPERATING: "Operating",
  TRANSFERRED: "Transferred",
  SUNSET: "Sunset"
});

export const outcomes = Object.freeze({
  SCALE: "Scale",
  TRANSFER: "Transfer",
  EXTEND: "Extend once",
  SUNSET: "Sunset"
});

export const reviewTypes = Object.freeze(["security", "privacy", "accessibility", "responsible_ai"]);

export function requiredReviewTypes(riskClassification) {
  if (riskClassification === "Internal") return ["accessibility", "responsible_ai"];
  return ["security", "privacy", "accessibility", "responsible_ai"];
}

export const decisionGateRequirements = Object.freeze({
  [outcomes.SCALE]: ["metric_evidence", "operating_owner", "capacity_plan", "reviews_complete"],
  [outcomes.TRANSFER]: ["metric_evidence", "receiving_owner_ack", "delivery_kit", "reviews_complete", "support_plan", "follow_up_scheduled"],
  [outcomes.EXTEND]: ["metric_evidence", "revised_scope", "sponsor_approval"],
  [outcomes.SUNSET]: ["learning_captured", "code_data_disposition"]
});

export class WorkflowError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function requireRole(actor, allowedRoles) {
  if (!actor || !allowedRoles.includes(actor.role)) {
    throw new WorkflowError("FORBIDDEN", "You do not have permission for this action.", 403);
  }
}

export function requireTransition(project, outcome) {
  if (!Object.values(outcomes).includes(outcome)) {
    throw new WorkflowError("INVALID_OUTCOME", "Unknown decision outcome.");
  }
  if (![stages.SELECTED, stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) {
    throw new WorkflowError("INVALID_STATE", `A decision cannot be requested from ${project.stage}.`, 409);
  }
  if (outcome === outcomes.EXTEND && project.extensionCount >= 1) {
    throw new WorkflowError("EXTENSION_LIMIT", "A Lab project can be extended only once.", 409);
  }
}

export function missingGates(outcome, gates, project = {}) {
  const complete = new Set(gates.filter(gate => ["complete", "excepted"].includes(gate.status)).map(gate => gate.key));
  const missing = (decisionGateRequirements[outcome] || []).filter(key => !complete.has(key));
  if (outcome !== outcomes.TRANSFER || !missing.includes("delivery_kit")) return missing;
  const unmetDeliveryItems = (project.deliveryKit || [])
    .filter(item => !["complete", "excepted"].includes(item.status))
    .map(item => `delivery_kit:${item.itemKey}`);
  return missing.flatMap(key => key === "delivery_kit" ? unmetDeliveryItems : [key]);
}

export function requiredApproverRoles(outcome, project) {
  const approvers = [roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR];
  if (project.sharedPlatformImpact) approvers.push(roles.PLATFORM_REVIEWER);
  return approvers;
}

export function finalStage(outcome) {
  return {
    [outcomes.SCALE]: stages.OPERATING,
    [outcomes.TRANSFER]: stages.TRANSFERRED,
    [outcomes.EXTEND]: stages.INCUBATING,
    [outcomes.SUNSET]: stages.SUNSET
  }[outcome];
}
