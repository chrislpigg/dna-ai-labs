import { WorkflowError } from "./workflow-policy.mjs";

export const fellowAssignmentStatuses = Object.freeze(["proposed", "active", "completed", "cancelled"]);

export function normalizeFellowAssignmentInput(input = {}, existing = {}) {
  const cycleId = String(input.cycleId ?? existing.cycleId ?? "").trim();
  const projectId = String(input.projectId ?? existing.projectId ?? "").trim();
  const fellowId = String(input.fellowId ?? existing.fellowId ?? "").trim();
  const assignmentRole = String(input.assignmentRole ?? input.role ?? existing.assignmentRole ?? "").trim();
  const managerId = String(input.managerId ?? existing.managerId ?? "").trim();
  const status = String(input.status ?? existing.status ?? "proposed").trim();
  const capacityUnits = Number(input.capacityUnits ?? existing.capacityUnits ?? 1);
  const outcome = String(input.outcome ?? existing.outcome ?? "").trim() || null;
  if (!cycleId) throw new WorkflowError("MISSING_FELLOW_CYCLE", "Fellow assignment requires a cycle.", 422);
  if (!projectId) throw new WorkflowError("MISSING_FELLOW_PROJECT", "Fellow assignment requires a project.", 422);
  if (!fellowId) throw new WorkflowError("MISSING_FELLOW", "Fellow assignment requires a fellow.", 422);
  if (!assignmentRole) throw new WorkflowError("MISSING_FELLOW_ROLE", "Fellow assignment requires a role.", 422);
  if (!managerId) throw new WorkflowError("MISSING_FELLOW_MANAGER", "Fellow assignment requires a manager.", 422);
  if (!fellowAssignmentStatuses.includes(status)) throw new WorkflowError("INVALID_FELLOW_ASSIGNMENT_STATUS", "Fellow assignment status is invalid.", 422);
  if (!Number.isInteger(capacityUnits) || capacityUnits < 1 || capacityUnits > 10) throw new WorkflowError("INVALID_FELLOW_CAPACITY", "Fellow capacity must be between 1 and 10.", 422);
  return { cycleId, projectId, fellowId, assignmentRole, managerId, status, capacityUnits, outcome };
}
