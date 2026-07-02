import { randomUUID } from "node:crypto";
import { assertStoragePort } from "./storage-port.mjs";
import { retentionExpired, retentionUntil } from "./retention-policy.mjs";
import { featureFlagDefaults, knownFeatureFlag } from "./feature-flags.mjs";
import { DisabledDirectoryAdapter, requireActiveDirectoryPersonSync } from "./directory-adapter.mjs";
import { ArtifactVerifier, artifactVerificationFields } from "./artifact-verifier.mjs";
import { enrichProjectDirectoryContextSync } from "./directory-context.mjs";
import { normalizeDeliveryKitInput, normalizeDeliveryKitItemKey } from "./delivery-kit.mjs";
import { normalizeFellowAssignmentInput } from "./fellow-assignments.mjs";
import { DisabledWorkTrackingAdapter } from "./work-tracking-adapter.mjs";
import { DisabledCalendarAdapter } from "./calendar-adapter.mjs";
import {
  WorkflowError,
  finalStage,
  missingGates,
  outcomes,
  requireRole,
  requireTransition,
  requiredApproverRoles,
  reviewTypes,
  roles,
  stages
} from "./workflow-policy.mjs";

const now = () => new Date().toISOString();
export const deletionReasons = Object.freeze(["duplicate", "withdrawn", "created_in_error", "governance_removal"]);
const draftAllowedRoles = [roles.EMPLOYEE, roles.SUBMITTER, roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN];

function normalizeDraftContent(input = {}) {
  const allowedKeys = [
    "title", "originTeam", "users", "potentialReach", "problem", "metric", "baseline", "target", "metricSource",
    "metricOwnerId", "sponsorId", "receivingOwnerId", "projectLeadId", "riskClassification", "transferDate",
    "sharedPlatformImpact", "adoptionGate", "evidenceGate", "cycleId", "capacityUnits"
  ];
  return Object.fromEntries(allowedKeys.filter(key => Object.hasOwn(input, key)).map(key => {
    const value = input[key];
    return [key, typeof value === "string" ? value.trim() : value];
  }));
}

function intakeRevisionContent(input = {}) {
  const content = normalizeDraftContent(input);
  return {
    ...content,
    cycleId: content.cycleId || "cycle-2026-q3",
    title: String(content.title ?? "").trim(),
    originTeam: String(content.originTeam ?? "").trim(),
    users: String(content.users ?? "").trim(),
    potentialReach: Number(content.potentialReach),
    problem: String(content.problem ?? "").trim(),
    metric: String(content.metric ?? "").trim(),
    baseline: String(content.baseline ?? "").trim(),
    target: String(content.target ?? "").trim(),
    metricSource: String(content.metricSource ?? "").trim(),
    metricOwnerId: String(content.metricOwnerId ?? "").trim(),
    sponsorId: String(content.sponsorId ?? "").trim(),
    receivingOwnerId: String(content.receivingOwnerId ?? "").trim(),
    projectLeadId: String(content.projectLeadId ?? "").trim(),
    riskClassification: String(content.riskClassification ?? "").trim(),
    transferDate: content.transferDate || null,
    sharedPlatformImpact: Boolean(content.sharedPlatformImpact),
    capacityUnits: Number(content.capacityUnits || 1),
    adoptionGate: Boolean(content.adoptionGate),
    evidenceGate: Boolean(content.evidenceGate)
  };
}

function changedRevisionFields(fromContent = {}, toContent = {}) {
  const keys = [...new Set([...Object.keys(fromContent), ...Object.keys(toContent)])].sort();
  return keys
    .filter(field => JSON.stringify(fromContent[field] ?? null) !== JSON.stringify(toContent[field] ?? null))
    .map(field => ({ field, before: fromContent[field] ?? null, after: toContent[field] ?? null }));
}

const collaboratorPermissions = Object.freeze(["edit"]);
const intakeOwnerRoles = [roles.SUBMITTER, roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN];
const triageParticipantRoles = [roles.SUBMITTER, roles.PROJECT_LEAD, roles.RECEIVING_OWNER];
const triageReviewerRoles = [roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.PLATFORM_REVIEWER, roles.STEERING_REVIEWER, roles.ADMIN];
const triageCommentKinds = Object.freeze(["comment", "request_for_information"]);
const cycleCapacityStages = new Set([stages.SELECTED, stages.INCUBATING, stages.DECISION_PENDING]);
const cycleStatuses = Object.freeze(["planned", "active", "closed"]);
const assignableRoles = Object.freeze(Object.values(roles));
const finalDecisionAuthorizationRoles = Object.freeze([roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.PLATFORM_REVIEWER, roles.STEERING_REVIEWER, roles.ADMIN]);

function dateOnly(value, label) {
  const text = String(value ?? "").trim();
  const date = new Date(`${text}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime())) {
    throw new WorkflowError("INVALID_CYCLE_DATE", `${label} must be a valid YYYY-MM-DD date.`, 422);
  }
  return text;
}

function normalizeCycleInput(input = {}, existing = {}) {
  const startsOn = dateOnly(input.startsOn ?? input.startDate ?? existing.startsOn, "Cycle start");
  const endsOn = dateOnly(input.endsOn ?? input.endDate ?? existing.endsOn, "Cycle end");
  if (new Date(`${endsOn}T12:00:00Z`) <= new Date(`${startsOn}T12:00:00Z`)) {
    throw new WorkflowError("INVALID_CYCLE_DATES", "Cycle end date must be after the start date.", 422);
  }
  const theme = String(input.theme ?? existing.theme ?? "").trim();
  if (!theme) throw new WorkflowError("INVALID_CYCLE_THEME", "Cycle theme is required.", 422);
  const name = String(input.name ?? existing.name ?? theme).trim();
  const capacityUnits = Number(input.capacityUnits ?? input.capacity ?? existing.capacityUnits);
  if (!Number.isInteger(capacityUnits) || capacityUnits < 1 || capacityUnits > 50) {
    throw new WorkflowError("INVALID_CYCLE_CAPACITY", "Cycle capacity must be between 1 and 50.", 422);
  }
  const rawGroup = input.steeringGroupIds ?? input.steeringGroup ?? existing.steeringGroupIds ?? [];
  if (!Array.isArray(rawGroup)) throw new WorkflowError("INVALID_STEERING_GROUP", "Steering group must be an array of user ids.", 422);
  const steeringGroupIds = [...new Set(rawGroup.map(value => String(value ?? "").trim()).filter(Boolean))];
  if (!steeringGroupIds.length) throw new WorkflowError("INVALID_STEERING_GROUP", "At least one steering group member is required.", 422);
  const status = String(input.status ?? existing.status ?? "planned").trim();
  if (!cycleStatuses.includes(status)) throw new WorkflowError("INVALID_CYCLE_STATUS", "Cycle status is invalid.", 422);
  return { name, theme, startsOn, endsOn, capacityUnits, steeringGroupIds, status };
}

function normalizeTriageComment(input = {}, kind = "comment") {
  if (!triageCommentKinds.includes(kind)) throw new WorkflowError("INVALID_TRIAGE_COMMENT_KIND", "Triage comment type is invalid.", 422);
  const comment = String(input.comment ?? input.message ?? "").trim();
  if (!comment) throw new WorkflowError("MISSING_TRIAGE_COMMENT", "A triage comment is required.", 422);
  if (comment.length > 2000) throw new WorkflowError("TRIAGE_COMMENT_TOO_LONG", "Triage comments must be 2,000 characters or fewer.", 422);
  return { comment, kind };
}

function normalizeCollaboratorRecords(input = {}) {
  const raw = Object.hasOwn(input, "collaborators")
    ? input.collaborators
    : (input.collaboratorIds || []).map(userId => ({ userId, permission: "edit" }));
  if (!Array.isArray(raw)) throw new WorkflowError("INVALID_COLLABORATORS", "Draft collaborators must be an array.", 422);
  const records = [];
  const seen = new Set();
  for (const item of raw) {
    const userId = String((typeof item === "object" && item !== null ? item.userId : item) ?? "").trim();
    if (!userId || seen.has(userId)) continue;
    const permission = String((typeof item === "object" && item !== null ? item.permission : "edit") ?? "edit").trim();
    if (!collaboratorPermissions.includes(permission)) throw new WorkflowError("INVALID_COLLABORATOR_PERMISSION", "Draft collaborator permission is invalid.", 422);
    records.push({ userId, permission });
    seen.add(userId);
  }
  if (records.length > 25) throw new WorkflowError("TOO_MANY_COLLABORATORS", "Draft collaborator limit exceeded.", 422);
  return records;
}

function normalizeSingleCollaborator(input = {}) {
  const [record] = normalizeCollaboratorRecords({ collaborators: [input] });
  if (!record) throw new WorkflowError("INVALID_COLLABORATOR", "A collaborator user id is required.", 422);
  return record;
}

function draftCollaboratorIds(draft) {
  return Array.isArray(draft.collaborators) ? draft.collaborators.map(collaborator => collaborator.userId) : (draft.collaboratorIds || []);
}

function normalizeCalendarEventInput(input = {}, project) {
  const eventType = String(input.eventType ?? "").trim();
  if (!["decision_meeting", "follow_up"].includes(eventType)) throw new WorkflowError("INVALID_CALENDAR_EVENT_TYPE", "Calendar event type is invalid.", 422);
  if (eventType === "decision_meeting" && !project.pendingDecision) throw new WorkflowError("DECISION_EVENT_REQUIRED", "A decision meeting requires an open decision request.", 409);
  if (eventType === "follow_up" && project.handoff?.status !== "accepted") throw new WorkflowError("FOLLOW_UP_HANDOFF_REQUIRED", "A follow-up event requires an accepted handoff.", 409);
  const scheduledFor = String(input.scheduledFor ?? (eventType === "follow_up" ? project.handoff?.followUpDate : "") ?? "").trim();
  const scheduledDate = new Date(scheduledFor.includes("T") ? scheduledFor : `${scheduledFor}T12:00:00`);
  if (!scheduledFor || Number.isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) throw new WorkflowError("INVALID_CALENDAR_EVENT_DATE", "Calendar event date must be in the future.", 422);
  const decisionId = eventType === "decision_meeting" ? project.pendingDecision.id : null;
  const eventKey = eventType === "decision_meeting" ? `decision_meeting:${decisionId}` : "follow_up";
  return {
    eventType,
    eventKey,
    decisionId,
    scheduledFor,
    externalUrl: String(input.externalUrl ?? input.eventUrl ?? "").trim() || null
  };
}

/** Server-owned governed workflow. It is intentionally independent of SQLite. */
export class WorkflowService {
  constructor(storage, { approvedArtifactOrigins = ["https://intranet.example"], directoryAdapter = new DisabledDirectoryAdapter(), artifactVerifier, workTrackingAdapter = new DisabledWorkTrackingAdapter(), calendarAdapter = new DisabledCalendarAdapter() } = {}) {
    this.storage = assertStoragePort(storage);
    this.approvedArtifactOrigins = new Set(approvedArtifactOrigins);
    this.directory = directoryAdapter;
    this.artifactVerifier = artifactVerifier || new ArtifactVerifier({ approvedOrigins: approvedArtifactOrigins });
    this.workTracking = workTrackingAdapter;
    this.calendar = calendarAdapter;
  }

  actor(id) { return this.storage.getActor(id); }
  users() { return this.storage.listUsers(); }
  listCycles() { return this.storage.listCycles(); }
  project(id) { return enrichProjectDirectoryContextSync(this.storage.getProject(id), this.directory); }
  listProjects() { return this.storage.listProjects().map(project => enrichProjectDirectoryContextSync(project, this.directory)); }
  intakeDraft(actor, id) {
    const draft = this.storage.getIntakeDraft(id);
    this.requireDraftAccess(actor, draft);
    return draft;
  }
  listIntakeDrafts(actor) {
    requireRole(actor, draftAllowedRoles);
    return this.storage.listIntakeDrafts(actor.id);
  }
  verifyAuditIntegrity() { return this.storage.verifyAuditIntegrity(); }

  async searchDirectoryPeople(actor, query) {
    requireRole(actor, draftAllowedRoles);
    const people = await this.directory.searchPeople(query);
    return people
      .filter(person => person.active)
      .map(person => ({ id: person.id, displayName: person.displayName, organization: person.organization, managerId: person.managerId, active: person.active }));
  }

  listFeatureFlags(actor) {
    requireRole(actor, [roles.ADMIN]);
    return this.storage.listFeatureFlags();
  }

  requireFeatureEnabled(key) {
    const flag = this.storage.getFeatureFlag(key) || { enabled: featureFlagDefaults[key] };
    if (!flag.enabled) throw new WorkflowError("FEATURE_DISABLED", "This feature is not enabled for the tenant.", 403, { featureFlag: key });
  }

  setFeatureFlag(actor, key, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const flagKey = String(key ?? "").trim();
    if (!knownFeatureFlag(flagKey)) throw new WorkflowError("UNKNOWN_FEATURE_FLAG", "Feature flag is not recognized.", 404);
    if (typeof input.enabled !== "boolean") throw new WorkflowError("INVALID_FEATURE_FLAG", "Feature flag enabled value must be boolean.", 422);
    const existing = this.storage.getFeatureFlag(flagKey) || { key: flagKey, enabled: featureFlagDefaults[flagKey], updatedAt: null, updatedBy: null };
    const timestamp = now();
    const next = { key: flagKey, enabled: input.enabled, updatedAt: timestamp, updatedBy: actor.id };
    this.storage.transaction(() => {
      this.storage.upsertFeatureFlag(next);
      this.storage.appendAudit(actor.id, "feature_flag_updated", "feature_flag", flagKey, { enabled: existing.enabled }, { enabled: next.enabled });
    });
    return this.storage.getFeatureFlag(flagKey);
  }

  recordIntegrationAttempt(integrationType, operation, context = {}, outcome, errorCode = null) {
    try {
      this.storage.appendIntegrationAttempt({
        id: randomUUID(),
        integrationType,
        operation,
        outcome,
        errorCode,
        projectId: context.projectId || null,
        entityType: context.entityType || null,
        actorId: context.actorId || null,
        occurredAt: now()
      });
    } catch {
      // Health telemetry must never mask the workflow result.
    }
  }

  runIntegrationAttempt(integrationType, operation, context, work) {
    try {
      const result = work();
      this.recordIntegrationAttempt(integrationType, operation, context, "success");
      return result;
    } catch (error) {
      const code = error instanceof WorkflowError ? error.code : "INTEGRATION_ERROR";
      this.recordIntegrationAttempt(integrationType, operation, context, code.includes("TIMEOUT") ? "timeout" : "failure", code);
      throw error;
    }
  }

  integrationHealth(actor) {
    requireRole(actor, [roles.ADMIN]);
    const attempts = this.storage.listIntegrationAttempts(100);
    const summary = ["artifact", "work_tracking", "calendar"].map(type => {
      const records = attempts.filter(attempt => attempt.integrationType === type);
      const last = records[0] || null;
      const failures = records.filter(attempt => attempt.outcome !== "success");
      return {
        integrationType: type,
        recentAttempts: records.length,
        recentFailures: failures.length,
        lastOutcome: last?.outcome || "none",
        lastErrorCode: last?.errorCode || null,
        lastAttemptAt: last?.occurredAt || null
      };
    });
    return { summary, attempts };
  }

  notificationOutbox(actor, limit = 100) {
    requireRole(actor, [roles.ADMIN]);
    return this.storage.listNotificationOutbox(limit);
  }

  notificationRecipientsForRoles(roleList = []) {
    const wanted = new Set(roleList);
    return this.storage.listUsers().filter(user => wanted.has(user.role)).map(user => user.id);
  }

  enqueueNotification(recipientId, notificationType, relatedEntityType, relatedEntityId, payload = {}, timestamp = now()) {
    if (!recipientId) return;
    this.storage.insertNotificationOutbox({
      id: randomUUID(),
      recipientId,
      notificationType,
      state: "pending",
      relatedEntityType,
      relatedEntityId,
      attemptCount: 0,
      payload,
      createdAt: timestamp,
      availableAt: timestamp,
      lastErrorCode: null
    });
  }

  enqueueRoleNotifications(roleList, notificationType, relatedEntityType, relatedEntityId, payload = {}, timestamp = now()) {
    for (const recipientId of this.notificationRecipientsForRoles(roleList)) {
      this.enqueueNotification(recipientId, notificationType, relatedEntityType, relatedEntityId, payload, timestamp);
    }
  }

  listRoleAssignments(actor) {
    requireRole(actor, [roles.ADMIN]);
    return this.storage.listRoleAssignments();
  }

  setRoleAssignment(actor, userId, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const targetUserId = String(userId ?? input.userId ?? "").trim();
    if (!targetUserId) throw new WorkflowError("INVALID_ROLE_ASSIGNMENT", "Role assignment requires a user id.", 422);
    this.actor(targetUserId);
    const role = String(input.role ?? "").trim();
    if (!assignableRoles.includes(role)) throw new WorkflowError("INVALID_ROLE", "Assigned role is invalid.", 422);
    const active = input.active === undefined ? true : Boolean(input.active);
    if (targetUserId === actor.id && active && finalDecisionAuthorizationRoles.includes(role)) {
      throw new WorkflowError("SELF_ROLE_ESCALATION", "Administrators cannot grant themselves final-decision authorization.", 403);
    }
    const existing = this.storage.getRoleAssignment(targetUserId);
    const timestamp = now();
    const next = { userId: targetUserId, role, active, assignedBy: actor.id, assignedAt: timestamp };
    this.storage.transaction(() => {
      this.storage.upsertRoleAssignment(next);
      this.storage.appendAudit(actor.id, "role_assignment_updated", "role_assignment", targetUserId, existing ? { role: existing.role, active: existing.active } : null, { role: next.role, active: next.active });
    });
    return this.storage.getRoleAssignment(targetUserId);
  }

  createCycle(actor, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const cycle = { id: randomUUID(), ...normalizeCycleInput(input) };
    for (const userId of cycle.steeringGroupIds) this.actor(userId);
    this.storage.transaction(() => {
      this.storage.insertCycle(cycle);
      this.storage.appendAudit(actor.id, "cycle_created", "cycle", cycle.id, null, { theme: cycle.theme, startsOn: cycle.startsOn, endsOn: cycle.endsOn, capacityUnits: cycle.capacityUnits, status: cycle.status });
    });
    return this.storage.getCycle(cycle.id);
  }

  updateCycle(actor, id, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const existing = this.storage.getCycle(id);
    const cycle = normalizeCycleInput(input, existing);
    for (const userId of cycle.steeringGroupIds) this.actor(userId);
    this.storage.transaction(() => {
      this.storage.updateCycle(id, cycle);
      this.storage.appendAudit(actor.id, "cycle_updated", "cycle", id, { theme: existing.theme, startsOn: existing.startsOn, endsOn: existing.endsOn, capacityUnits: existing.capacityUnits, status: existing.status }, { theme: cycle.theme, startsOn: cycle.startsOn, endsOn: cycle.endsOn, capacityUnits: cycle.capacityUnits, status: cycle.status });
    });
    return this.storage.getCycle(id);
  }

  requireDraftAccess(actor, draft) {
    requireRole(actor, draftAllowedRoles);
    if (draft.ownerId !== actor.id && !draftCollaboratorIds(draft).includes(actor.id)) {
      throw new WorkflowError("FORBIDDEN", "You do not have access to this draft.", 403);
    }
  }

  createIntakeDraft(actor, input = {}) {
    requireRole(actor, draftAllowedRoles);
    const id = randomUUID();
    const timestamp = now();
    const collaborators = normalizeCollaboratorRecords(input);
    for (const collaborator of collaborators) {
      if (collaborator.userId === actor.id) throw new WorkflowError("INVALID_COLLABORATOR", "The draft owner does not need collaborator access.", 422);
      this.actor(collaborator.userId);
    }
    const draft = {
      id, status: stages.DRAFT, ownerId: actor.id, collaborators, collaboratorIds: collaborators.map(collaborator => collaborator.userId),
      content: normalizeDraftContent(input.content || input),
      createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id
    };
    this.storage.transaction(() => {
      this.storage.insertIntakeDraft(draft);
      for (const collaborator of collaborators) {
        this.storage.insertIntakeDraftCollaborator(id, { ...collaborator, addedAt: timestamp, addedBy: actor.id });
        this.storage.appendAudit(actor.id, "intake_draft_collaborator_added", "intake_draft_collaborator", `${id}:${collaborator.userId}`, null, { draftId: id, userId: collaborator.userId, permission: collaborator.permission });
      }
      this.storage.appendAudit(actor.id, "intake_draft_created", "intake_draft", id, null, { status: stages.DRAFT });
    });
    return this.intakeDraft(actor, id);
  }

  updateIntakeDraft(actor, id, input = {}) {
    const draft = this.storage.getIntakeDraft(id);
    this.requireDraftAccess(actor, draft);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can be updated.", 409);
    if (Object.hasOwn(input, "ownerId") && input.ownerId !== draft.ownerId) throw new WorkflowError("FORBIDDEN", "Draft ownership cannot be changed.", 403);
    if (Object.hasOwn(input, "status") && input.status !== draft.status) throw new WorkflowError("FORBIDDEN", "Drafts cannot be submitted through the update endpoint.", 403);
    if (Object.hasOwn(input, "collaboratorIds") || Object.hasOwn(input, "collaborators")) throw new WorkflowError("COLLABORATOR_ENDPOINT_REQUIRED", "Use the collaborator endpoint to change draft collaborators.", 409);
    const contentPatch = normalizeDraftContent(input.content || input);
    const content = { ...draft.content, ...contentPatch };
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.updateIntakeDraft(id, { content, updatedAt: timestamp, updatedBy: actor.id });
      this.storage.appendAudit(actor.id, "intake_draft_updated", "intake_draft", id, { updatedAt: draft.updatedAt }, { updatedAt: timestamp });
    });
    return this.intakeDraft(actor, id);
  }

  addIntakeDraftCollaborator(actor, id, input = {}) {
    const draft = this.storage.getIntakeDraft(id);
    requireRole(actor, draftAllowedRoles);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can change collaborators.", 409);
    if (draft.ownerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the draft owner can add collaborators.", 403);
    const collaborator = normalizeSingleCollaborator(input);
    if (collaborator.userId === draft.ownerId) throw new WorkflowError("INVALID_COLLABORATOR", "The draft owner does not need collaborator access.", 422);
    if (draftCollaboratorIds(draft).includes(collaborator.userId)) throw new WorkflowError("COLLABORATOR_EXISTS", "Draft collaborator already exists.", 409);
    this.actor(collaborator.userId);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertIntakeDraftCollaborator(id, { ...collaborator, addedAt: timestamp, addedBy: actor.id });
      this.storage.updateIntakeDraft(id, { content: draft.content, updatedAt: timestamp, updatedBy: actor.id });
      this.storage.appendAudit(actor.id, "intake_draft_collaborator_added", "intake_draft_collaborator", `${id}:${collaborator.userId}`, null, { draftId: id, userId: collaborator.userId, permission: collaborator.permission });
    });
    return this.intakeDraft(actor, id);
  }

  removeIntakeDraftCollaborator(actor, id, collaboratorId) {
    const draft = this.storage.getIntakeDraft(id);
    requireRole(actor, draftAllowedRoles);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can change collaborators.", 409);
    if (draft.ownerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the draft owner can remove collaborators.", 403);
    const userId = String(collaboratorId ?? "").trim();
    const collaborator = (draft.collaborators || []).find(item => item.userId === userId);
    if (!userId || !collaborator) throw new WorkflowError("NOT_FOUND", "Draft collaborator not found.", 404);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.deleteIntakeDraftCollaborator(id, userId);
      this.storage.updateIntakeDraft(id, { content: draft.content, updatedAt: timestamp, updatedBy: actor.id });
      this.storage.appendAudit(actor.id, "intake_draft_collaborator_removed", "intake_draft_collaborator", `${id}:${userId}`, { draftId: id, userId, permission: collaborator.permission }, null);
    });
    return this.intakeDraft(actor, id);
  }

  deleteProject(actor, id, deletionReason) {
    requireRole(actor, [roles.ADMIN]);
    const project = this.storage.getProjectIncludingDeleted(id);
    if (project.deletedAt) throw new WorkflowError("ALREADY_DELETED", "Project is already deleted.", 409);
    if (!retentionExpired(this.storage.projectRetentionUntil(id))) throw new WorkflowError("RETENTION_ACTIVE", "A retained final decision prevents ordinary deletion.", 409);
    if (!deletionReasons.includes(deletionReason)) throw new WorkflowError("INVALID_DELETION_REASON", "Deletion reason is invalid.", 422);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.softDeleteProject(id, actor.id, deletionReason, timestamp);
      this.storage.appendAudit(actor.id, "project_deleted", "project", id, { deletedAt: null }, { deletionReason, deletedAt: timestamp });
    });
  }

  restoreProject(actor, id) {
    requireRole(actor, [roles.ADMIN]);
    const project = this.storage.getProjectIncludingDeleted(id);
    if (!project.deletedAt) throw new WorkflowError("NOT_DELETED", "Project is not deleted.", 409);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.restoreProject(id, actor.id, timestamp);
      this.storage.appendAudit(actor.id, "project_restored", "project", id, { deletedAt: project.deletedAt, deletionReason: project.deletionReason }, { deletedAt: null });
    });
    return this.project(id);
  }

  validateIntake(input) {
    const required = ["title", "originTeam", "users", "problem", "metric", "baseline", "target", "metricSource", "metricOwnerId", "sponsorId", "receivingOwnerId", "projectLeadId", "riskClassification"];
    const missing = required.filter(key => !String(input[key] ?? "").trim());
    if (missing.length) throw new WorkflowError("INVALID_INTAKE", "Required intake information is missing.", 422, { missing });
    if (!Number.isInteger(Number(input.potentialReach)) || Number(input.potentialReach) < 1) throw new WorkflowError("INVALID_REACH", "Potential company reach must be at least one team.", 422);
    if (Object.hasOwn(input, "capacityUnits") && (!Number.isInteger(Number(input.capacityUnits)) || Number(input.capacityUnits) < 1 || Number(input.capacityUnits) > 10)) throw new WorkflowError("INVALID_CAPACITY_UNITS", "Project capacity units must be between 1 and 10.", 422);
    if (input.transferDate && new Date(`${input.transferDate}T12:00:00`) <= new Date()) throw new WorkflowError("INVALID_TRANSFER_DATE", "Transfer target must be in the future.", 422);
    this.actor(input.sponsorId); this.actor(input.projectLeadId); this.actor(input.metricOwnerId);
    this.actor(input.receivingOwnerId);
    requireActiveDirectoryPersonSync(this.directory, input.sponsorId, "Sponsor");
    requireActiveDirectoryPersonSync(this.directory, input.receivingOwnerId, "Receiving owner");
    requireActiveDirectoryPersonSync(this.directory, input.metricOwnerId, "Metric owner");
    requireActiveDirectoryPersonSync(this.directory, input.projectLeadId, "Project lead");
    if (!input.adoptionGate || !input.evidenceGate) throw new WorkflowError("GATES_UNCONFIRMED", "Adoption and evidence gates must be confirmed before submission.", 422);
  }

  createIntake(actor, input) {
    requireRole(actor, intakeOwnerRoles);
    this.validateIntake(input);
    const content = intakeRevisionContent(input);
    const id = randomUUID(); const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertProject({
        id, cycleId: content.cycleId, title: content.title, stage: stages.SUBMITTED,
        originTeam: content.originTeam, users: content.users, potentialReach: content.potentialReach,
        problem: content.problem, metric: content.metric, baseline: content.baseline, target: content.target,
        metricSource: content.metricSource, metricOwnerId: content.metricOwnerId, sponsorId: content.sponsorId,
        receivingOwnerId: content.receivingOwnerId || null, projectLeadId: content.projectLeadId,
        riskClassification: content.riskClassification, transferDate: content.transferDate,
        sharedPlatformImpact: content.sharedPlatformImpact, capacityUnits: content.capacityUnits,
        createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id
      });
      this.storage.insertIntakeRevision({ id: randomUUID(), projectId: id, revisionNumber: 1, content, submittedBy: actor.id, submittedAt: timestamp });
      this.storage.appendAudit(actor.id, "intake_submitted", "project", id, null, { stage: stages.SUBMITTED, title: content.title, revisionNumber: 1 });
      this.enqueueRoleNotifications([roles.LAB_LEAD, roles.ADMIN], "intake_submitted", "project", id, { projectId: id, stage: stages.SUBMITTED }, timestamp);
    });
    return this.project(id);
  }

  submitIntakeDraft(actor, id) {
    requireRole(actor, intakeOwnerRoles);
    const draft = this.storage.getIntakeDraft(id);
    if (draft.ownerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the draft owner can submit this intake.", 403);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can be submitted.", 409);
    const input = draft.content || {};
    this.validateIntake(input);
    const content = intakeRevisionContent(input);
    const projectId = randomUUID();
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertProject({
        id: projectId, cycleId: content.cycleId, title: content.title, stage: stages.SUBMITTED,
        originTeam: content.originTeam, users: content.users, potentialReach: content.potentialReach,
        problem: content.problem, metric: content.metric, baseline: content.baseline, target: content.target,
        metricSource: content.metricSource, metricOwnerId: content.metricOwnerId, sponsorId: content.sponsorId,
        receivingOwnerId: content.receivingOwnerId, projectLeadId: content.projectLeadId,
        riskClassification: content.riskClassification, transferDate: content.transferDate,
        sharedPlatformImpact: content.sharedPlatformImpact, capacityUnits: content.capacityUnits,
        createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id
      });
      this.storage.insertIntakeRevision({ id: randomUUID(), projectId, revisionNumber: 1, content, submittedBy: actor.id, submittedAt: timestamp });
      this.storage.updateIntakeDraftStatus(id, stages.SUBMITTED, timestamp, actor.id);
      this.storage.appendAudit(actor.id, "intake_submitted", "project", projectId, null, { stage: stages.SUBMITTED, title: content.title, draftId: id, revisionNumber: 1 });
      this.storage.appendAudit(actor.id, "intake_draft_submitted", "intake_draft", id, { status: stages.DRAFT }, { status: stages.SUBMITTED, projectId });
      this.enqueueRoleNotifications([roles.LAB_LEAD, roles.ADMIN], "intake_submitted", "project", projectId, { projectId, stage: stages.SUBMITTED, draftId: id }, timestamp);
    });
    return this.project(projectId);
  }

  listIntakeRevisions(actor, projectId) {
    const project = this.project(projectId);
    this.requireTriageProject(project);
    this.requireTriageCommentAccess(actor, project);
    return this.storage.listIntakeRevisions(projectId);
  }

  resubmitIntake(actor, projectId, input = {}) {
    this.requireFeatureEnabled("intake_resubmission");
    requireRole(actor, intakeOwnerRoles);
    const project = this.project(projectId);
    if (project.createdBy !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the intake owner can resubmit this intake.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged intakes can be resubmitted.", 409);
    this.validateIntake(input);
    const content = intakeRevisionContent(input);
    const previous = this.storage.listIntakeRevisions(projectId).at(-1) || null;
    const revisionNumber = Number(previous?.revisionNumber || 0) + 1;
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.updateProjectIntakeContent(projectId, content, actor.id, timestamp);
      this.storage.insertIntakeRevision({ id: randomUUID(), projectId, revisionNumber, content, submittedBy: actor.id, submittedAt: timestamp });
      this.storage.appendAudit(actor.id, "intake_resubmitted", "project", projectId, previous ? { revisionNumber: previous.revisionNumber } : null, { revisionNumber, changedFields: previous ? changedRevisionFields(previous.content, content).map(change => change.field) : [] });
    });
    return { project: this.project(projectId), revision: this.storage.getIntakeRevision(projectId, revisionNumber) };
  }

  compareIntakeRevisions(actor, projectId, fromRevisionNumber, toRevisionNumber) {
    const project = this.project(projectId);
    this.requireTriageProject(project);
    this.requireTriageCommentAccess(actor, project);
    const fromNumber = Number(fromRevisionNumber);
    const toNumber = Number(toRevisionNumber);
    if (!Number.isInteger(fromNumber) || !Number.isInteger(toNumber) || fromNumber < 1 || toNumber < 1) {
      throw new WorkflowError("INVALID_REVISION", "Revision numbers must be positive integers.", 422);
    }
    const from = this.storage.getIntakeRevision(projectId, fromNumber);
    const to = this.storage.getIntakeRevision(projectId, toNumber);
    if (!from || !to) throw new WorkflowError("REVISION_NOT_FOUND", "Intake revision not found.", 404);
    return { projectId, fromRevision: from, toRevision: to, changes: changedRevisionFields(from.content, to.content) };
  }

  withdrawIntake(actor, id) {
    requireRole(actor, intakeOwnerRoles);
    const project = this.project(id);
    if (project.createdBy !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the intake owner can withdraw it.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged intakes can be withdrawn.", 409);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.softDeleteProject(id, actor.id, "withdrawn", timestamp);
      this.storage.appendAudit(actor.id, "intake_withdrawn", "project", id, { stage: project.stage, deletedAt: null }, { deletionReason: "withdrawn", deletedAt: timestamp });
    });
    return { id, withdrawnAt: timestamp, deletionReason: "withdrawn" };
  }

  isTriageReviewer(actor) {
    return triageReviewerRoles.includes(actor?.role);
  }

  requireTriageCommentAccess(actor, project) {
    if (this.isTriageReviewer(actor)) return;
    requireRole(actor, triageParticipantRoles);
    const participantIds = new Set([
      project.createdBy, project.metricOwnerId, project.sponsor?.id, project.receivingOwner?.id, project.projectLead?.id
    ].filter(Boolean));
    if (!participantIds.has(actor.id)) {
      throw new WorkflowError("FORBIDDEN", "You do not have access to this intake triage thread.", 403);
    }
  }

  requireTriageProject(project) {
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) {
      throw new WorkflowError("INVALID_STATE", "Triage comments apply only to submitted or triaged intakes.", 409);
    }
  }

  listTriageComments(actor, projectId) {
    const project = this.project(projectId);
    this.requireTriageCommentAccess(actor, project);
    return this.storage.listTriageComments(projectId);
  }

  addTriageComment(actor, projectId, input = {}) {
    const project = this.project(projectId);
    this.requireTriageProject(project);
    this.requireTriageCommentAccess(actor, project);
    const id = randomUUID();
    const timestamp = now();
    const comment = normalizeTriageComment(input);
    this.storage.transaction(() => {
      this.storage.insertTriageComment({ id, projectId, authorId: actor.id, kind: comment.kind, comment: comment.comment, createdAt: timestamp });
      this.storage.appendAudit(actor.id, "triage_comment_added", "triage_comment", id, null, { projectId, kind: comment.kind });
    });
    return this.listTriageComments(actor, projectId);
  }

  requestTriageInformation(actor, projectId, input = {}) {
    requireRole(actor, triageReviewerRoles);
    const project = this.project(projectId);
    this.requireTriageProject(project);
    const id = randomUUID();
    const timestamp = now();
    const comment = normalizeTriageComment(input, "request_for_information");
    this.storage.transaction(() => {
      this.storage.insertTriageComment({ id, projectId, authorId: actor.id, kind: comment.kind, comment: comment.comment, createdAt: timestamp });
      this.storage.updateProjectTriageStatus(projectId, "information_requested", actor.id, timestamp);
      this.storage.appendAudit(actor.id, "triage_information_requested", "triage_comment", id, { triageStatus: project.triageStatus || "open", stage: project.stage }, { triageStatus: "information_requested", stage: project.stage, projectId });
    });
    return { project: this.project(projectId), comments: this.listTriageComments(actor, projectId) };
  }

  selectProject(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(id);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged projects can be selected.", 409);
    if (!project.receivingOwner) throw new WorkflowError("MISSING_RECEIVING_OWNER", "Selection requires a named receiving owner.", 409);
    if (project.directoryAssignments?.receivingOwner?.active !== true) throw new WorkflowError("RECEIVING_OWNER_INACTIVE", "Selection requires an active directory-verified receiving owner.", 409, { userId: project.receivingOwner.id });
    if (!project.adoptionAcknowledged) throw new WorkflowError("MISSING_ADOPTION_ACK", "Selection requires acknowledgement from the named receiving owner.", 409);
    const cycle = this.storage.getCycle(project.cycleId);
    const usedCapacity = this.storage.cycleCapacityUsage(project.cycleId, [...cycleCapacityStages]);
    const remainingCapacity = Math.max(0, cycle.capacityUnits - usedCapacity);
    if (project.capacityUnits > remainingCapacity) {
      throw new WorkflowError("CYCLE_CAPACITY_EXCEEDED", "Selection would exceed the cycle's approved capacity.", 409, { cycleId: project.cycleId, capacityUnits: project.capacityUnits, usedCapacity, remainingCapacity });
    }
    this.storage.transaction(() => {
      this.storage.updateProjectStage(id, stages.SELECTED, actor.id, now());
      this.storage.appendAudit(actor.id, "project_selected", "project", id, { stage: project.stage }, { stage: stages.SELECTED });
    });
    return this.project(id);
  }

  acknowledgeAdoption(actor, projectId) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can acknowledge this adoption path.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Adoption acknowledgement must happen before selection.", 409);
    if (project.adoptionAcknowledged) throw new WorkflowError("ADOPTION_ALREADY_ACKNOWLEDGED", "This adoption path has already been acknowledged.", 409);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.acknowledgeProjectAdoption(projectId, actor.id, timestamp);
      this.storage.appendAudit(actor.id, "adoption_acknowledged", "project", projectId, { adoptionAcknowledged: false }, { adoptionAcknowledged: true });
      this.enqueueNotification(project.projectLead?.id, "adoption_acknowledged", "project", projectId, { projectId }, timestamp);
    });
    return this.project(projectId);
  }

  startIncubation(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(id);
    if (project.stage !== stages.SELECTED) throw new WorkflowError("INVALID_STATE", "Only selected projects can start incubation.", 409);
    this.storage.transaction(() => {
      this.storage.updateProjectStage(id, stages.INCUBATING, actor.id, now());
      this.storage.appendAudit(actor.id, "incubation_started", "project", id, { stage: project.stage }, { stage: stages.INCUBATING });
    });
    return this.project(id);
  }

  setGate(actor, projectId, key, input) {
    requireRole(actor, [roles.LAB_LEAD, roles.PLATFORM_REVIEWER, roles.ADMIN]);
    const project = this.project(projectId);
    if (!String(key).match(/^[a-z_]+$/)) throw new WorkflowError("INVALID_GATE", "Gate key is invalid.", 422);
    if (key === "receiving_owner_ack") throw new WorkflowError("HANDOFF_REQUIRED", "Only the named receiving owner can complete the handoff acknowledgement.", 409);
    if (key === "metric_evidence") throw new WorkflowError("EVIDENCE_ENTRY_REQUIRED", "Metric evidence is completed only by recording a structured metric result.", 409);
    if (key === "reviews_complete") throw new WorkflowError("REVIEW_RECORD_REQUIRED", "Review completion is calculated from required review records.", 409);
    if (!["complete", "excepted", "incomplete"].includes(input.status)) throw new WorkflowError("INVALID_GATE_STATUS", "Gate status is invalid.", 422);
    if (input.status === "complete" && !String(input.evidenceLink ?? "").trim()) throw new WorkflowError("MISSING_EVIDENCE", "Completed gates require an approved evidence link.", 422);
    if (input.status === "excepted" && !String(input.exceptionReason ?? "").trim()) throw new WorkflowError("MISSING_EXCEPTION", "Excepted gates require a written risk acceptance.", 422);
    const verification = input.status === "complete" ? this.verifyArtifactLink(input.evidenceLink, { entityType: "project_gate", projectId, key, actorId: actor.id }) : null;
    const before = project.gates.find(gate => gate.key === key) || null; const timestamp = now();
    this.storage.transaction(() => {
      this.storage.upsertGate({ projectId, key, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null, ...artifactVerificationFields(verification) });
      this.storage.appendAudit(actor.id, "gate_updated", "project_gate", `${projectId}:${key}`, before, { key, status: input.status, artifactVerificationStatus: verification?.status || null });
      if (key === "delivery_kit" && input.status === "excepted") this.storage.appendAudit(actor.id, "delivery_kit_exception_accepted", "project_gate", `${projectId}:${key}`, before, { exceptionReason: input.exceptionReason.trim() });
    });
    return this.project(projectId);
  }

  validateEvidenceLink(value) {
    this.artifactVerifier.validateAllowedUrl(value);
  }

  verifyArtifactLink(value, context = {}) {
    return this.runIntegrationAttempt("artifact", "verify", context, () => this.artifactVerifier.verifyLinkSync(value, context));
  }

  addEvidence(actor, projectId, input) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(projectId);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can record evidence only for their assigned projects.", 403);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Evidence can be recorded only during incubation or decision review.", 409);
    if (!["metric_result", "user_feedback", "pilot_demo"].includes(input.evidenceType)) throw new WorkflowError("INVALID_EVIDENCE_TYPE", "Evidence type is invalid.", 422);
    if (!String(input.result ?? "").trim()) throw new WorkflowError("MISSING_EVIDENCE_RESULT", "Evidence requires a result summary.", 422);
    if (!Number.isInteger(Number(input.sampleSize)) || Number(input.sampleSize) < 1) throw new WorkflowError("INVALID_SAMPLE_SIZE", "Evidence requires a sample size of at least one.", 422);
    if (!["low", "medium", "high"].includes(input.confidence)) throw new WorkflowError("INVALID_CONFIDENCE", "Evidence confidence is invalid.", 422);
    const verification = this.verifyArtifactLink(input.sourceLink, { entityType: "evidence", projectId, evidenceType: input.evidenceType, actorId: actor.id });
    const observed = new Date(`${input.observedAt}T12:00:00`);
    if (!input.observedAt || Number.isNaN(observed.getTime()) || observed > new Date()) throw new WorkflowError("INVALID_OBSERVED_DATE", "Evidence date must be today or earlier.", 422);
    const id = randomUUID(); const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertEvidence({ id, projectId, evidenceType: input.evidenceType, result: input.result.trim(), sampleSize: Number(input.sampleSize), confidence: input.confidence, sourceLink: input.sourceLink.trim(), observedAt: input.observedAt, createdBy: actor.id, createdAt: timestamp, ...artifactVerificationFields(verification) });
      if (input.evidenceType === "metric_result") this.storage.upsertGate({ projectId, key: "metric_evidence", status: "complete", evidenceLink: input.sourceLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null, ...artifactVerificationFields(verification) });
      this.storage.appendAudit(actor.id, "evidence_recorded", "evidence", id, null, { projectId, evidenceType: input.evidenceType, confidence: input.confidence, artifactVerificationStatus: verification.status });
    });
    return this.project(projectId);
  }

  setReview(actor, projectId, reviewType, input) {
    requireRole(actor, [roles.PLATFORM_REVIEWER, roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(projectId);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Reviews can be recorded only during incubation or decision review.", 409);
    if (!reviewTypes.includes(reviewType) || !project.reviewRequirements.includes(reviewType)) throw new WorkflowError("INVALID_REVIEW_TYPE", "This review is not required for the project risk classification.", 422);
    if (!["complete", "excepted", "incomplete"].includes(input.status)) throw new WorkflowError("INVALID_REVIEW_STATUS", "Review status is invalid.", 422);
    const verification = input.status === "complete" ? this.verifyArtifactLink(input.evidenceLink, { entityType: "project_review", projectId, reviewType, actorId: actor.id }) : null;
    if (input.status === "excepted" && !String(input.exceptionReason ?? "").trim()) throw new WorkflowError("MISSING_EXCEPTION", "An excepted review requires written risk acceptance.", 422);
    const before = project.reviews.find(review => review.reviewType === reviewType) || null; const timestamp = now();
    this.storage.transaction(() => {
      this.storage.upsertReview({ projectId, reviewType, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null, ...artifactVerificationFields(verification) });
      const complete = project.reviewRequirements.every(type => this.storage.listReviews(projectId).some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status)));
      this.storage.upsertGate({ projectId, key: "reviews_complete", status: complete ? "complete" : "incomplete", evidenceLink: complete ? input.evidenceLink?.trim() || null : null, completedBy: complete ? actor.id : null, completedAt: complete ? timestamp : null, exceptionReason: null, ...artifactVerificationFields(complete ? verification : null) });
      this.storage.appendAudit(actor.id, "review_updated", "project_review", `${projectId}:${reviewType}`, before, { reviewType, status: input.status, reviewsComplete: complete, artifactVerificationStatus: verification?.status || null });
      this.enqueueNotification(project.projectLead?.id, "review_updated", "project_review", `${projectId}:${reviewType}`, { projectId, reviewType, status: input.status }, timestamp);
    });
    return this.project(projectId);
  }

  requireDeliveryKitWriteAccess(actor, project) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) {
      throw new WorkflowError("FORBIDDEN", "Project leads can update delivery-kit items only for their assigned projects.", 403);
    }
  }

  listDeliveryKit(actor, projectId) {
    requireRole(actor, Object.values(roles));
    this.project(projectId);
    return this.storage.listDeliveryKitItems(projectId);
  }

  upsertDeliveryKitItem(actor, projectId, itemKey, input = {}) {
    const project = this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const key = normalizeDeliveryKitItemKey(itemKey);
    const item = normalizeDeliveryKitInput(input);
    this.actor(item.ownerId);
    const verification = item.evidenceLink ? this.verifyArtifactLink(item.evidenceLink, { entityType: "delivery_kit_item", projectId, itemKey: key, actorId: actor.id }) : null;
    const before = this.storage.listDeliveryKitItems(projectId).find(existing => existing.itemKey === key) || null;
    const timestamp = now();
    const next = {
      projectId,
      itemKey: key,
      status: item.status,
      ownerId: item.ownerId,
      evidenceLink: item.evidenceLink,
      acceptedAt: item.status === "complete" ? timestamp : null,
      acceptedBy: item.status === "complete" ? actor.id : null,
      updatedAt: timestamp,
      updatedBy: actor.id,
      ...artifactVerificationFields(verification)
    };
    this.storage.transaction(() => {
      this.storage.upsertDeliveryKitItem(next);
      this.storage.appendAudit(actor.id, "delivery_kit_item_updated", "delivery_kit_item", `${projectId}:${key}`, before, { itemKey: key, status: next.status, ownerId: next.ownerId, artifactVerificationStatus: verification?.status || null });
    });
    return this.storage.listDeliveryKitItems(projectId).find(existing => existing.itemKey === key);
  }

  deleteDeliveryKitItem(actor, projectId, itemKey) {
    const project = this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const key = normalizeDeliveryKitItemKey(itemKey);
    const before = this.storage.listDeliveryKitItems(projectId).find(existing => existing.itemKey === key) || null;
    this.storage.transaction(() => {
      this.storage.deleteDeliveryKitItem(projectId, key);
      this.storage.appendAudit(actor.id, "delivery_kit_item_deleted", "delivery_kit_item", `${projectId}:${key}`, before, null);
    });
    return this.storage.listDeliveryKitItems(projectId).find(existing => existing.itemKey === key);
  }

  createOrLinkWorkItem(actor, projectId, input = {}) {
    this.requireFeatureEnabled("work_tracking_integration");
    const project = this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const before = this.storage.getProjectWorkItem(projectId);
    const verified = this.runIntegrationAttempt("work_tracking", "create_or_link", { projectId, entityType: "project_work_item", actorId: actor.id }, () => this.workTracking.createOrLinkSync(input, { projectId, actorId: actor.id }));
    const timestamp = now();
    const next = {
      projectId,
      provider: verified.provider,
      externalRef: verified.externalRef,
      externalUrl: verified.externalUrl,
      externalStatus: verified.externalStatus,
      lastVerifiedAt: verified.lastVerifiedAt,
      linkedBy: before?.linkedBy || actor.id,
      linkedAt: before?.linkedAt || timestamp,
      updatedBy: actor.id,
      updatedAt: timestamp
    };
    this.storage.transaction(() => {
      this.storage.upsertProjectWorkItem(next);
      this.storage.appendAudit(actor.id, before ? "work_item_linked" : "work_item_created", "project_work_item", projectId, before, {
        provider: next.provider, externalRef: next.externalRef, externalStatus: next.externalStatus, lastVerifiedAt: next.lastVerifiedAt
      });
    });
    return this.storage.getProjectWorkItem(projectId);
  }

  refreshWorkItem(actor, projectId) {
    this.requireFeatureEnabled("work_tracking_integration");
    const project = this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const before = this.storage.getProjectWorkItem(projectId);
    if (!before) throw new WorkflowError("WORK_ITEM_NOT_FOUND", "Project does not have a linked work item.", 404);
    const verified = this.runIntegrationAttempt("work_tracking", "refresh", { projectId, entityType: "project_work_item", actorId: actor.id }, () => this.workTracking.refreshSync(before, { projectId, actorId: actor.id }));
    const timestamp = now();
    const next = {
      ...before,
      provider: verified.provider,
      externalRef: verified.externalRef,
      externalUrl: verified.externalUrl,
      externalStatus: verified.externalStatus,
      lastVerifiedAt: verified.lastVerifiedAt,
      updatedBy: actor.id,
      updatedAt: timestamp
    };
    this.storage.transaction(() => {
      this.storage.upsertProjectWorkItem(next);
      this.storage.appendAudit(actor.id, "work_item_refreshed", "project_work_item", projectId, before, {
        provider: next.provider, externalRef: next.externalRef, externalStatus: next.externalStatus, lastVerifiedAt: next.lastVerifiedAt
      });
    });
    return this.storage.getProjectWorkItem(projectId);
  }

  listCalendarEvents(actor, projectId) {
    requireRole(actor, Object.values(roles));
    this.project(projectId);
    return this.storage.listProjectCalendarEvents(projectId);
  }

  scheduleCalendarEvent(actor, projectId, input = {}) {
    this.requireFeatureEnabled("calendar_integration");
    const project = this.project(projectId);
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.PLATFORM_REVIEWER, roles.EXECUTIVE_SPONSOR, roles.RECEIVING_OWNER, roles.ADMIN]);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can schedule calendar events only for their assigned projects.", 403);
    if (actor.role === roles.RECEIVING_OWNER && project.receivingOwner?.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Receiving owners can schedule calendar events only for their assigned projects.", 403);
    const event = normalizeCalendarEventInput(input, project);
    const before = this.storage.getProjectCalendarEvent(projectId, event.eventKey);
    const verified = this.runIntegrationAttempt("calendar", "create_or_validate", { projectId, entityType: "project_calendar_event", actorId: actor.id }, () => this.calendar.createOrValidateSync({ ...event, eventUrl: event.externalUrl }, { projectId, actorId: actor.id, decisionId: event.decisionId }));
    const timestamp = now();
    const next = {
      projectId,
      eventKey: event.eventKey,
      eventType: event.eventType,
      decisionId: event.decisionId,
      provider: verified.provider,
      externalRef: verified.externalRef,
      externalUrl: verified.externalUrl,
      scheduledFor: verified.scheduledFor,
      lastVerifiedAt: verified.lastVerifiedAt,
      createdBy: before?.createdBy || actor.id,
      createdAt: before?.createdAt || timestamp,
      updatedBy: actor.id,
      updatedAt: timestamp
    };
    this.storage.transaction(() => {
      this.storage.upsertProjectCalendarEvent(next);
      this.storage.appendAudit(actor.id, "calendar_event_scheduled", "project_calendar_event", `${projectId}:${event.eventKey}`, before, {
        eventType: next.eventType, decisionId: next.decisionId, externalRef: next.externalRef, scheduledFor: next.scheduledFor, lastVerifiedAt: next.lastVerifiedAt
      });
      if (event.eventType === "follow_up") this.enqueueNotification(project.projectLead?.id, "follow_up_scheduled", "project_calendar_event", `${projectId}:${event.eventKey}`, { projectId, eventType: event.eventType, scheduledFor: next.scheduledFor }, timestamp);
    });
    return this.storage.getProjectCalendarEvent(projectId, event.eventKey);
  }

  listFellowAssignments(actor, filters = {}) {
    requireRole(actor, Object.values(roles));
    return this.storage.listFellowAssignments({
      cycleId: String(filters.cycleId ?? "").trim() || null,
      projectId: String(filters.projectId ?? "").trim() || null
    });
  }

  createFellowAssignment(actor, input = {}) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const fellow = requireActiveDirectoryPersonSync(this.directory, input.fellowId, "Fellow");
    const data = normalizeFellowAssignmentInput({ ...input, managerId: input.managerId || fellow.managerId });
    const project = this.project(data.projectId);
    this.storage.getCycle(data.cycleId);
    if (project.cycleId !== data.cycleId) throw new WorkflowError("FELLOW_ASSIGNMENT_SCOPE_MISMATCH", "Fellow assignment cycle must match the project cycle.", 422);
    this.actor(data.fellowId); this.actor(data.managerId);
    if (data.status === "active") throw new WorkflowError("MANAGER_ACK_REQUIRED", "Manager acknowledgement is required before a Fellow assignment can become active.", 409);
    const id = randomUUID(); const timestamp = now();
    const assignment = { id, ...data, status: data.status, managerAcknowledgedAt: null, managerAcknowledgedBy: null, createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id };
    this.storage.transaction(() => {
      this.storage.insertFellowAssignment(assignment);
      this.storage.appendAudit(actor.id, "fellow_assignment_created", "fellow_assignment", id, null, { cycleId: data.cycleId, projectId: data.projectId, fellowId: data.fellowId, status: assignment.status });
    });
    return this.storage.getFellowAssignment(id);
  }

  updateFellowAssignment(actor, id, input = {}) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const existing = this.storage.getFellowAssignment(id);
    const data = normalizeFellowAssignmentInput(input, existing);
    const project = this.project(data.projectId);
    this.storage.getCycle(data.cycleId);
    if (project.cycleId !== data.cycleId) throw new WorkflowError("FELLOW_ASSIGNMENT_SCOPE_MISMATCH", "Fellow assignment cycle must match the project cycle.", 422);
    this.actor(data.fellowId); this.actor(data.managerId);
    const managerAcknowledgedAt = existing.managerAcknowledgedAt && existing.managerId === data.managerId ? existing.managerAcknowledgedAt : null;
    const managerAcknowledgedBy = existing.managerAcknowledgedAt && existing.managerId === data.managerId ? existing.managerAcknowledgedBy : null;
    if (data.status === "active" && !managerAcknowledgedAt) throw new WorkflowError("MANAGER_ACK_REQUIRED", "Manager acknowledgement is required before a Fellow assignment can become active.", 409);
    const timestamp = now();
    const patch = { ...data, managerAcknowledgedAt, managerAcknowledgedBy, updatedAt: timestamp, updatedBy: actor.id };
    this.storage.transaction(() => {
      this.storage.updateFellowAssignment(id, patch);
      this.storage.appendAudit(actor.id, "fellow_assignment_updated", "fellow_assignment", id, { status: existing.status, managerId: existing.managerId }, { status: patch.status, managerId: patch.managerId });
    });
    return this.storage.getFellowAssignment(id);
  }

  acknowledgeFellowAssignment(actor, id) {
    const existing = this.storage.getFellowAssignment(id);
    if (existing.managerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the assigned Fellow manager can acknowledge this assignment.", 403);
    if (existing.status !== "proposed") throw new WorkflowError("INVALID_FELLOW_ASSIGNMENT_STATE", "Only proposed Fellow assignments can be acknowledged.", 409);
    const timestamp = now();
    const patch = { ...existing, status: "active", managerAcknowledgedAt: timestamp, managerAcknowledgedBy: actor.id, updatedAt: timestamp, updatedBy: actor.id };
    this.storage.transaction(() => {
      this.storage.updateFellowAssignment(id, patch);
      this.storage.appendAudit(actor.id, "fellow_assignment_acknowledged", "fellow_assignment", id, { status: existing.status }, { status: "active", managerAcknowledgedAt: timestamp });
    });
    return this.storage.getFellowAssignment(id);
  }

  acceptHandoff(actor, projectId, input) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can accept this handoff.", 403);
    if (!project.pendingDecision || project.pendingDecision.outcome !== outcomes.TRANSFER) throw new WorkflowError("INVALID_HANDOFF_STATE", "A transfer decision request is required before handoff acceptance.", 409);
    if (!input.onboardingAcknowledged) throw new WorkflowError("ONBOARDING_REQUIRED", "Receiving owner must acknowledge onboarding before accepting handoff.", 422);
    const verification = this.verifyArtifactLink(input.adoptionPlanLink, { entityType: "handoff", projectId, actorId: actor.id });
    this.validateFutureDate(input.supportEndDate, "Support end date"); this.validateFutureDate(input.followUpDate, "Follow-up date");
    const timestamp = now(); const existing = this.storage.getHandoff(projectId);
    if (existing?.status === "accepted") throw new WorkflowError("HANDOFF_ALREADY_ACCEPTED", "This handoff has already been accepted.", 409);
    this.storage.transaction(() => {
      this.storage.upsertHandoff({ projectId, receivingOwnerId: actor.id, status: "accepted", adoptionPlanLink: input.adoptionPlanLink.trim(), supportEndDate: input.supportEndDate, followUpDate: input.followUpDate, onboardingAcknowledged: true, acceptedBy: actor.id, acceptedAt: timestamp, ...artifactVerificationFields(verification) });
      for (const key of ["receiving_owner_ack", "support_plan", "follow_up_scheduled"]) this.storage.upsertGate({ projectId, key, status: "complete", evidenceLink: input.adoptionPlanLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null, ...artifactVerificationFields(verification) });
      this.storage.appendAudit(actor.id, "handoff_accepted", "handoff", projectId, existing || null, { status: "accepted", supportEndDate: input.supportEndDate, followUpDate: input.followUpDate, artifactVerificationStatus: verification.status });
      this.enqueueNotification(project.projectLead?.id, "handoff_accepted", "handoff", projectId, { projectId, followUpDate: input.followUpDate }, timestamp);
    });
    return this.project(projectId);
  }

  validateFutureDate(value, label) {
    const date = new Date(`${value}T12:00:00`);
    if (!value || Number.isNaN(date.getTime()) || date <= new Date()) throw new WorkflowError("INVALID_DATE", `${label} must be in the future.`, 422);
  }

  requestDecision(actor, projectId, input) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(projectId);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can request decisions only for their assigned projects.", 403);
    requireTransition(project, input.outcome);
    if (!String(input.rationale ?? "").trim()) throw new WorkflowError("MISSING_RATIONALE", "A decision rationale is required.", 422);
    if (this.storage.findOpenDecision(projectId)) throw new WorkflowError("PENDING_DECISION", "A decision is already awaiting approval.", 409);
    const id = randomUUID(); const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertDecision({ id, projectId, outcome: input.outcome, rationale: input.rationale.trim(), status: "requested", requestedBy: actor.id, requestedAt: timestamp });
      this.storage.updateProjectStage(projectId, stages.DECISION_PENDING, actor.id, timestamp);
      this.storage.appendAudit(actor.id, "decision_requested", "decision", id, null, { projectId, outcome: input.outcome, missingGates: missingGates(input.outcome, project.gates, project) });
      this.enqueueRoleNotifications(requiredApproverRoles(input.outcome, project), "decision_requested", "decision", id, { projectId, outcome: input.outcome }, timestamp);
    });
    return this.decision(id);
  }

  decision(id) {
    const decision = this.storage.getDecision(id);
    if (!decision) throw new WorkflowError("NOT_FOUND", "Decision not found.", 404);
    const project = this.project(decision.projectId);
    return { ...decision, approvals: this.storage.listApprovals(id), missingGates: missingGates(decision.outcome, project.gates, project), requiredApprovers: requiredApproverRoles(decision.outcome, project) };
  }

  approveDecision(actor, id, input) {
    const decision = this.decision(id);
    if (decision.status !== "requested") throw new WorkflowError("INVALID_DECISION_STATE", "Only requested decisions can be approved.", 409);
    if (decision.requestedBy === actor.id) throw new WorkflowError("SELF_APPROVAL", "A requester cannot approve their own decision.", 403);
    if (!decision.requiredApprovers.includes(actor.role)) throw new WorkflowError("FORBIDDEN", "You are not a required approver for this decision.", 403);
    if (!["approved", "rejected"].includes(input.result)) throw new WorkflowError("INVALID_APPROVAL", "Approval result is invalid.", 422);
    if (!String(input.comment ?? "").trim()) throw new WorkflowError("MISSING_APPROVAL_COMMENT", "An approval comment is required.", 422);
    if (decision.approvals.some(approval => approval.approverRole === actor.role)) throw new WorkflowError("DUPLICATE_APPROVAL", "This approval role has already responded.", 409);
    const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertApproval({ id: randomUUID(), decisionId: id, approverId: actor.id, approverRole: actor.role, result: input.result, comment: input.comment.trim(), createdAt: timestamp });
      if (input.result === "rejected") {
        this.storage.rejectDecision(id, actor.id, timestamp, decision.projectId, stages.INCUBATING);
        this.storage.appendAudit(actor.id, "decision_rejected", "decision", id, { stage: stages.DECISION_PENDING }, { stage: stages.INCUBATING, role: actor.role, comment: input.comment.trim() });
      } else this.storage.appendAudit(actor.id, "decision_approved", "decision", id, null, { result: input.result, role: actor.role });
    });
    return this.decision(id);
  }

  finalizeDecision(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const decision = this.decision(id);
    if (decision.status !== "requested") throw new WorkflowError("INVALID_DECISION_STATE", "Only requested decisions can be finalized.", 409);
    const rejected = decision.approvals.find(approval => approval.result === "rejected");
    if (rejected) throw new WorkflowError("DECISION_REJECTED", "A required approver rejected this decision.", 409, { rejectedBy: rejected.approverRole });
    const approvedRoles = new Set(decision.approvals.filter(approval => approval.result === "approved").map(approval => approval.approverRole));
    const missingApprovals = decision.requiredApprovers.filter(role => !approvedRoles.has(role));
    if (missingApprovals.length) throw new WorkflowError("MISSING_APPROVALS", "Required approvals are incomplete.", 409, { missingApprovals });
    if (decision.missingGates.length) throw new WorkflowError("MISSING_GATES", "Decision gates are incomplete.", 409, { missingGates: decision.missingGates });
    const project = this.project(decision.projectId); const stage = finalStage(decision.outcome); const timestamp = now();
    this.storage.transaction(() => {
      this.storage.finalizeDecision(id, actor.id, timestamp, project.id, stage, decision.outcome === outcomes.EXTEND ? 1 : 0, retentionUntil(timestamp));
      this.storage.appendAudit(actor.id, "decision_finalized", "decision", id, { stage: project.stage }, { stage, outcome: decision.outcome });
    });
    return { decision: this.decision(id), project: this.project(project.id) };
  }

  auditEvents(actor, limit = 100) {
    requireRole(actor, [roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.ADMIN]);
    return this.storage.listAuditEvents(limit);
  }
}
