import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresReadAdapter } from "./postgres-read-adapter.mjs";
import { deletionReasons } from "./workflow-service.mjs";
import { retentionClassification, retentionExpired, retentionUntil } from "./retention-policy.mjs";
import { auditEventHash, auditGenesisHash, verifyAuditChain } from "./audit-integrity.mjs";
import { featureFlagDefaults, knownFeatureFlag } from "./feature-flags.mjs";
import { DisabledDirectoryAdapter, requireActiveDirectoryPerson } from "./directory-adapter.mjs";
import { enrichProjectDirectoryContext } from "./directory-context.mjs";
import { defaultDeliveryKitItems, normalizeDeliveryKitInput, normalizeDeliveryKitItemKey } from "./delivery-kit.mjs";
import { normalizeFellowAssignmentInput } from "./fellow-assignments.mjs";
import { ArtifactVerifier, artifactVerificationFields } from "./artifact-verifier.mjs";
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
const databaseUnavailable = () => new WorkflowError("DATABASE_UNAVAILABLE", "The authoritative database is unavailable.", 503);
const requiredText = (value, label) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
};
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
const assignableRoles = Object.freeze(Object.values(roles));
const finalDecisionAuthorizationRoles = Object.freeze([roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.PLATFORM_REVIEWER, roles.STEERING_REVIEWER, roles.ADMIN]);

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

const cycleStatuses = Object.freeze(["planned", "active", "closed"]);

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
  if (new Date(`${endsOn}T12:00:00Z`) <= new Date(`${startsOn}T12:00:00Z`)) throw new WorkflowError("INVALID_CYCLE_DATES", "Cycle end date must be after the start date.", 422);
  const theme = String(input.theme ?? existing.theme ?? "").trim();
  if (!theme) throw new WorkflowError("INVALID_CYCLE_THEME", "Cycle theme is required.", 422);
  const name = String(input.name ?? existing.name ?? theme).trim();
  const capacityUnits = Number(input.capacityUnits ?? input.capacity ?? existing.capacityUnits);
  if (!Number.isInteger(capacityUnits) || capacityUnits < 1 || capacityUnits > 50) throw new WorkflowError("INVALID_CYCLE_CAPACITY", "Cycle capacity must be between 1 and 50.", 422);
  const rawGroup = input.steeringGroupIds ?? input.steeringGroup ?? existing.steeringGroupIds ?? [];
  if (!Array.isArray(rawGroup)) throw new WorkflowError("INVALID_STEERING_GROUP", "Steering group must be an array of user ids.", 422);
  const steeringGroupIds = [...new Set(rawGroup.map(value => String(value ?? "").trim()).filter(Boolean))];
  if (!steeringGroupIds.length) throw new WorkflowError("INVALID_STEERING_GROUP", "At least one steering group member is required.", 422);
  const status = String(input.status ?? existing.status ?? "planned").trim();
  if (!cycleStatuses.includes(status)) throw new WorkflowError("INVALID_CYCLE_STATUS", "Cycle status is invalid.", 422);
  return { name, theme, startsOn, endsOn, capacityUnits, steeringGroupIds, status };
}

class PostgresTransaction {
  constructor(client, organizationId) {
    this.client = client;
    this.organizationId = organizationId;
  }

  async query(sql, values = []) {
    try { return await this.client.query(sql, values); } catch { throw databaseUnavailable(); }
  }

  async insertProject(project) {
    await this.query(`INSERT INTO projects (
      id, organization_id, cycle_id, title, stage, origin_team, target_users, potential_reach, problem, metric, baseline, target,
      metric_source, metric_owner_id, sponsor_id, receiving_owner_id, project_lead_id, risk_classification, transfer_date,
      shared_platform_impact, capacity_units, created_at, created_by, updated_at, updated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`, [
      project.id, this.organizationId, project.cycleId, project.title, project.stage, project.originTeam, project.users,
      project.potentialReach, project.problem, project.metric, project.baseline, project.target, project.metricSource,
      project.metricOwnerId, project.sponsorId, project.receivingOwnerId, project.projectLeadId, project.riskClassification,
      project.transferDate, project.sharedPlatformImpact, project.capacityUnits || 1, project.createdAt, project.createdBy, project.updatedAt, project.updatedBy
    ]);
  }

  async insertCycle(cycle) {
    await this.query(`INSERT INTO cycles (
      id, organization_id, name, theme, starts_on, ends_on, capacity_units, steering_group_ids, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`, [
      cycle.id, this.organizationId, cycle.name, cycle.theme, cycle.startsOn, cycle.endsOn,
      cycle.capacityUnits, JSON.stringify(cycle.steeringGroupIds), cycle.status
    ]);
  }

  async updateCycle(id, cycle) {
    await this.query(`UPDATE cycles
      SET name = $3, theme = $4, starts_on = $5, ends_on = $6, capacity_units = $7, steering_group_ids = $8::jsonb, status = $9
      WHERE organization_id = $1 AND id = $2`, [
      this.organizationId, id, cycle.name, cycle.theme, cycle.startsOn, cycle.endsOn,
      cycle.capacityUnits, JSON.stringify(cycle.steeringGroupIds), cycle.status
    ]);
  }

  async upsertFeatureFlag(flag) {
    await this.query(`INSERT INTO feature_flags (organization_id, flag_key, enabled, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`, [
      this.organizationId, flag.key, flag.enabled, flag.updatedAt, flag.updatedBy
    ]);
  }

  async upsertRoleAssignment(assignment) {
    await this.query(`INSERT INTO role_assignments (organization_id, user_id, assigned_role, active, assigned_by, assigned_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET assigned_role = EXCLUDED.assigned_role, active = EXCLUDED.active, assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at`, [
      this.organizationId, assignment.userId, assignment.role, assignment.active, assignment.assignedBy, assignment.assignedAt
    ]);
  }

  async insertIntakeDraft(draft) {
    await this.query(`INSERT INTO intake_drafts (
      id, organization_id, status, owner_id, collaborator_ids, content, created_at, created_by, updated_at, updated_by
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`, [
      draft.id, this.organizationId, draft.status, draft.ownerId, JSON.stringify([]),
      JSON.stringify(draft.content), draft.createdAt, draft.createdBy, draft.updatedAt, draft.updatedBy
    ]);
  }

  async updateIntakeDraft(id, draft) {
    await this.query(`UPDATE intake_drafts
      SET content = $3::jsonb, updated_at = $4, updated_by = $5
      WHERE organization_id = $1 AND id = $2`, [
      this.organizationId, id, JSON.stringify(draft.content), draft.updatedAt, draft.updatedBy
    ]);
  }

  async updateIntakeDraftStatus(id, status, timestamp, actorId) {
    await this.query(`UPDATE intake_drafts
      SET status = $3, updated_at = $4, updated_by = $5
      WHERE organization_id = $1 AND id = $2`, [
      this.organizationId, id, status, timestamp, actorId
    ]);
  }

  async insertIntakeDraftCollaborator(draftId, collaborator) {
    await this.query(`INSERT INTO intake_draft_collaborators (
      draft_id, organization_id, collaborator_id, permission, added_at, added_by
    ) VALUES ($1, $2, $3, $4, $5, $6)`, [
      draftId, this.organizationId, collaborator.userId, collaborator.permission, collaborator.addedAt, collaborator.addedBy
    ]);
  }

  async deleteIntakeDraftCollaborator(draftId, collaboratorId) {
    await this.query("DELETE FROM intake_draft_collaborators WHERE organization_id = $1 AND draft_id = $2 AND collaborator_id = $3", [this.organizationId, draftId, collaboratorId]);
  }

  async insertTriageComment(comment) {
    await this.query(`INSERT INTO project_triage_comments (
      id, organization_id, project_id, author_id, comment_kind, comment_text, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      comment.id, this.organizationId, comment.projectId, comment.authorId, comment.kind, comment.comment, comment.createdAt
    ]);
  }

  async updateProjectTriageStatus(projectId, triageStatus, actorId, timestamp) {
    await this.query(`UPDATE projects
      SET triage_status = $3, information_requested_by = $4, information_requested_at = $5, updated_at = $5, updated_by = $4
      WHERE organization_id = $1 AND id = $2`, [
      this.organizationId, projectId, triageStatus, actorId, timestamp
    ]);
  }

  async insertIntakeRevision(revision) {
    await this.query(`INSERT INTO intake_revisions (
      id, organization_id, project_id, revision_number, content, submitted_by, submitted_at
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [
      revision.id, this.organizationId, revision.projectId, revision.revisionNumber,
      JSON.stringify(revision.content), revision.submittedBy, revision.submittedAt
    ]);
  }

  async updateProjectIntakeContent(projectId, input, actorId, timestamp) {
    await this.query(`UPDATE projects SET title = $3, cycle_id = $4, origin_team = $5, target_users = $6, potential_reach = $7,
      problem = $8, metric = $9, baseline = $10, target = $11, metric_source = $12, metric_owner_id = $13, sponsor_id = $14,
      receiving_owner_id = $15, project_lead_id = $16, risk_classification = $17, transfer_date = $18, shared_platform_impact = $19, capacity_units = $20,
      triage_status = 'open', information_requested_by = NULL, information_requested_at = NULL, updated_at = $21, updated_by = $22
      WHERE organization_id = $1 AND id = $2`, [
      this.organizationId, projectId, input.title, input.cycleId, input.originTeam, input.users, input.potentialReach,
      input.problem, input.metric, input.baseline, input.target, input.metricSource, input.metricOwnerId, input.sponsorId,
      input.receivingOwnerId, input.projectLeadId, input.riskClassification, input.transferDate, input.sharedPlatformImpact,
      input.capacityUnits || 1, timestamp, actorId
    ]);
  }

  async cycleCapacityUsage(cycleId, stagesForUsage = []) {
    const result = await this.query("SELECT COALESCE(SUM(capacity_units), 0) AS used FROM projects WHERE organization_id = $1 AND cycle_id = $2 AND deleted_at IS NULL AND stage = ANY($3::text[])", [this.organizationId, cycleId, stagesForUsage]);
    return Number(result.rows?.[0]?.used || 0);
  }

  async updateProjectStage(id, stage, actorId, timestamp) {
    await this.query("UPDATE projects SET stage = $3, updated_at = $4, updated_by = $5 WHERE organization_id = $1 AND id = $2", [this.organizationId, id, stage, timestamp, actorId]);
  }

  async acknowledgeProjectAdoption(projectId, actorId, timestamp) {
    await this.query("UPDATE projects SET adoption_acknowledged_by = $3, adoption_acknowledged_at = $4, updated_at = $4, updated_by = $3 WHERE organization_id = $1 AND id = $2", [this.organizationId, projectId, actorId, timestamp]);
  }

  async upsertGate(gate) {
    await this.query(`INSERT INTO project_gates (
        project_id, organization_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason,
        artifact_verification_status, artifact_verified_at, artifact_verification_method
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (project_id, gate_key) DO UPDATE SET status = EXCLUDED.status, evidence_link = EXCLUDED.evidence_link,
        completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at, exception_reason = EXCLUDED.exception_reason,
        artifact_verification_status = EXCLUDED.artifact_verification_status,
        artifact_verified_at = EXCLUDED.artifact_verified_at,
        artifact_verification_method = EXCLUDED.artifact_verification_method
      WHERE project_gates.organization_id = EXCLUDED.organization_id`, [
      gate.projectId, this.organizationId, gate.key, gate.status, gate.evidenceLink, gate.completedBy, gate.completedAt, gate.exceptionReason,
      gate.artifactVerificationStatus || null, gate.artifactVerifiedAt || null, gate.artifactVerificationMethod || null
    ]);
  }

  async insertEvidence(evidence) {
    await this.query(`INSERT INTO evidence_entries (
        id, organization_id, project_id, evidence_type, result, sample_size, confidence, source_link, observed_at, created_by, created_at,
        artifact_verification_status, artifact_verified_at, artifact_verification_method
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [
      evidence.id, this.organizationId, evidence.projectId, evidence.evidenceType, evidence.result, evidence.sampleSize,
      evidence.confidence, evidence.sourceLink, evidence.observedAt, evidence.createdBy, evidence.createdAt,
      evidence.artifactVerificationStatus || null, evidence.artifactVerifiedAt || null, evidence.artifactVerificationMethod || null
    ]);
  }

  async upsertReview(review) {
    await this.query(`INSERT INTO project_reviews (
        project_id, organization_id, review_type, status, evidence_link, completed_by, completed_at, exception_reason,
        artifact_verification_status, artifact_verified_at, artifact_verification_method
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (project_id, review_type) DO UPDATE SET status = EXCLUDED.status, evidence_link = EXCLUDED.evidence_link,
        completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at, exception_reason = EXCLUDED.exception_reason,
        artifact_verification_status = EXCLUDED.artifact_verification_status,
        artifact_verified_at = EXCLUDED.artifact_verified_at,
        artifact_verification_method = EXCLUDED.artifact_verification_method
      WHERE project_reviews.organization_id = EXCLUDED.organization_id`, [
      review.projectId, this.organizationId, review.reviewType, review.status, review.evidenceLink, review.completedBy, review.completedAt, review.exceptionReason,
      review.artifactVerificationStatus || null, review.artifactVerifiedAt || null, review.artifactVerificationMethod || null
    ]);
  }

  async listReviews(projectId) {
    const result = await this.query(`SELECT review_type AS "reviewType", status, evidence_link AS "evidenceLink",
      artifact_verification_status AS "artifactVerificationStatus", artifact_verified_at AS "artifactVerifiedAt",
      artifact_verification_method AS "artifactVerificationMethod"
      FROM project_reviews WHERE organization_id = $1 AND project_id = $2`, [this.organizationId, projectId]);
    return result.rows || [];
  }

  async listDeliveryKitItems(projectId) {
    const result = await this.query(`SELECT project_id AS "projectId", item_key AS "itemKey", status, owner_id AS "ownerId",
      evidence_link AS "evidenceLink", accepted_at AS "acceptedAt", accepted_by AS "acceptedBy", updated_at AS "updatedAt", updated_by AS "updatedBy",
      artifact_verification_status AS "artifactVerificationStatus", artifact_verified_at AS "artifactVerifiedAt",
      artifact_verification_method AS "artifactVerificationMethod"
      FROM delivery_kit_items WHERE organization_id = $1 AND project_id = $2 ORDER BY item_key`, [this.organizationId, projectId]);
    return result.rows || [];
  }

  async upsertDeliveryKitItem(item) {
    await this.query(`INSERT INTO delivery_kit_items (
        project_id, organization_id, item_key, status, owner_id, evidence_link, accepted_at, accepted_by, updated_at, updated_by,
        artifact_verification_status, artifact_verified_at, artifact_verification_method
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (project_id, organization_id, item_key) DO UPDATE SET status = EXCLUDED.status, owner_id = EXCLUDED.owner_id,
        evidence_link = EXCLUDED.evidence_link, accepted_at = EXCLUDED.accepted_at, accepted_by = EXCLUDED.accepted_by,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by,
        artifact_verification_status = EXCLUDED.artifact_verification_status,
        artifact_verified_at = EXCLUDED.artifact_verified_at,
        artifact_verification_method = EXCLUDED.artifact_verification_method`, [
      item.projectId, this.organizationId, item.itemKey, item.status, item.ownerId, item.evidenceLink,
      item.acceptedAt, item.acceptedBy, item.updatedAt, item.updatedBy,
      item.artifactVerificationStatus || null, item.artifactVerifiedAt || null, item.artifactVerificationMethod || null
    ]);
  }

  async deleteDeliveryKitItem(projectId, itemKey) {
    await this.query("DELETE FROM delivery_kit_items WHERE organization_id = $1 AND project_id = $2 AND item_key = $3", [this.organizationId, projectId, itemKey]);
  }

  async getProjectWorkItem(projectId) {
    const result = await this.query(`SELECT project_id AS "projectId", provider, external_ref AS "externalRef", external_url AS "externalUrl",
      external_status AS "externalStatus", last_verified_at AS "lastVerifiedAt", linked_by AS "linkedBy", linked_at AS "linkedAt",
      updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM project_work_items WHERE organization_id = $1 AND project_id = $2`, [this.organizationId, projectId]);
    return result.rows?.[0] || null;
  }

  async upsertProjectWorkItem(item) {
    await this.query(`INSERT INTO project_work_items (
        project_id, organization_id, provider, external_ref, external_url, external_status, last_verified_at,
        linked_by, linked_at, updated_by, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (organization_id, project_id) DO UPDATE SET provider = EXCLUDED.provider,
        external_ref = EXCLUDED.external_ref, external_url = EXCLUDED.external_url,
        external_status = EXCLUDED.external_status, last_verified_at = EXCLUDED.last_verified_at,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [
      item.projectId, this.organizationId, item.provider, item.externalRef, item.externalUrl, item.externalStatus,
      item.lastVerifiedAt, item.linkedBy, item.linkedAt, item.updatedBy, item.updatedAt
    ]);
  }

  async listProjectCalendarEvents(projectId) {
    const result = await this.query(`SELECT project_id AS "projectId", event_key AS "eventKey", event_type AS "eventType",
      decision_id AS "decisionId", provider, external_ref AS "externalRef", external_url AS "externalUrl",
      scheduled_for AS "scheduledFor", last_verified_at AS "lastVerifiedAt", created_by AS "createdBy", created_at AS "createdAt",
      updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM project_calendar_events WHERE organization_id = $1 AND project_id = $2 ORDER BY scheduled_for, event_key`, [this.organizationId, projectId]);
    return result.rows || [];
  }

  async getProjectCalendarEvent(projectId, eventKey) {
    const result = await this.query(`SELECT project_id AS "projectId", event_key AS "eventKey", event_type AS "eventType",
      decision_id AS "decisionId", provider, external_ref AS "externalRef", external_url AS "externalUrl",
      scheduled_for AS "scheduledFor", last_verified_at AS "lastVerifiedAt", created_by AS "createdBy", created_at AS "createdAt",
      updated_by AS "updatedBy", updated_at AS "updatedAt"
      FROM project_calendar_events WHERE organization_id = $1 AND project_id = $2 AND event_key = $3`, [this.organizationId, projectId, eventKey]);
    return result.rows?.[0] || null;
  }

  async upsertProjectCalendarEvent(event) {
    await this.query(`INSERT INTO project_calendar_events (
        project_id, organization_id, event_key, event_type, decision_id, provider, external_ref, external_url,
        scheduled_for, last_verified_at, created_by, created_at, updated_by, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (organization_id, project_id, event_key) DO UPDATE SET provider = EXCLUDED.provider,
        external_ref = EXCLUDED.external_ref, external_url = EXCLUDED.external_url,
        scheduled_for = EXCLUDED.scheduled_for, last_verified_at = EXCLUDED.last_verified_at,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [
      event.projectId, this.organizationId, event.eventKey, event.eventType, event.decisionId, event.provider, event.externalRef,
      event.externalUrl, event.scheduledFor, event.lastVerifiedAt, event.createdBy, event.createdAt, event.updatedBy, event.updatedAt
    ]);
  }

  async listFellowAssignments(filters = {}) {
    const clauses = [];
    const params = [this.organizationId];
    if (filters.cycleId) { params.push(filters.cycleId); clauses.push(`cycle_id = $${params.length}`); }
    if (filters.projectId) { params.push(filters.projectId); clauses.push(`project_id = $${params.length}`); }
    const where = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
    const result = await this.query(`SELECT id, cycle_id AS "cycleId", project_id AS "projectId", fellow_id AS "fellowId",
      assignment_role AS "assignmentRole", capacity_units AS "capacityUnits", status, manager_id AS "managerId",
      manager_acknowledged_at AS "managerAcknowledgedAt", manager_acknowledged_by AS "managerAcknowledgedBy",
      outcome, created_at AS "createdAt", created_by AS "createdBy", updated_at AS "updatedAt", updated_by AS "updatedBy"
      FROM fellow_assignments WHERE organization_id = $1${where} ORDER BY updated_at DESC, id`, params);
    return result.rows || [];
  }

  async getFellowAssignment(id) {
    const result = await this.query(`SELECT id, cycle_id AS "cycleId", project_id AS "projectId", fellow_id AS "fellowId",
      assignment_role AS "assignmentRole", capacity_units AS "capacityUnits", status, manager_id AS "managerId",
      manager_acknowledged_at AS "managerAcknowledgedAt", manager_acknowledged_by AS "managerAcknowledgedBy",
      outcome, created_at AS "createdAt", created_by AS "createdBy", updated_at AS "updatedAt", updated_by AS "updatedBy"
      FROM fellow_assignments WHERE organization_id = $1 AND id = $2`, [this.organizationId, id]);
    const row = result.rows?.[0];
    if (!row) throw new WorkflowError("NOT_FOUND", "Fellow assignment not found.", 404);
    return row;
  }

  async insertFellowAssignment(assignment) {
    await this.query(`INSERT INTO fellow_assignments (id, organization_id, cycle_id, project_id, fellow_id, assignment_role, capacity_units,
      status, manager_id, manager_acknowledged_at, manager_acknowledged_by, outcome, created_at, created_by, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, [
      assignment.id, this.organizationId, assignment.cycleId, assignment.projectId, assignment.fellowId, assignment.assignmentRole,
      assignment.capacityUnits, assignment.status, assignment.managerId, assignment.managerAcknowledgedAt, assignment.managerAcknowledgedBy,
      assignment.outcome, assignment.createdAt, assignment.createdBy, assignment.updatedAt, assignment.updatedBy
    ]);
  }

  async updateFellowAssignment(id, patch) {
    await this.query(`UPDATE fellow_assignments SET assignment_role = $3, capacity_units = $4, status = $5, manager_id = $6,
      manager_acknowledged_at = $7, manager_acknowledged_by = $8, outcome = $9, updated_at = $10, updated_by = $11
      WHERE organization_id = $1 AND id = $2`, [
      this.organizationId, id, patch.assignmentRole, patch.capacityUnits, patch.status, patch.managerId,
      patch.managerAcknowledgedAt, patch.managerAcknowledgedBy, patch.outcome, patch.updatedAt, patch.updatedBy
    ]);
  }

  async getHandoff(projectId) {
    const result = await this.query(`SELECT project_id AS "projectId", receiving_owner_id AS "receivingOwnerId", status,
      adoption_plan_link AS "adoptionPlanLink", support_end_date AS "supportEndDate", follow_up_date AS "followUpDate",
      onboarding_acknowledged AS "onboardingAcknowledged", accepted_by AS "acceptedBy", accepted_at AS "acceptedAt",
      artifact_verification_status AS "artifactVerificationStatus", artifact_verified_at AS "artifactVerifiedAt",
      artifact_verification_method AS "artifactVerificationMethod"
      FROM handoffs WHERE organization_id = $1 AND project_id = $2`, [this.organizationId, projectId]);
    const handoff = result.rows?.[0];
    return handoff ? { ...handoff, onboardingAcknowledged: Boolean(handoff.onboardingAcknowledged) } : null;
  }

  async upsertHandoff(handoff) {
    await this.query(`INSERT INTO handoffs (
        project_id, organization_id, receiving_owner_id, status, adoption_plan_link, support_end_date, follow_up_date,
        onboarding_acknowledged, accepted_by, accepted_at, artifact_verification_status, artifact_verified_at, artifact_verification_method
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (project_id) DO UPDATE SET status = EXCLUDED.status, adoption_plan_link = EXCLUDED.adoption_plan_link,
        support_end_date = EXCLUDED.support_end_date, follow_up_date = EXCLUDED.follow_up_date,
        onboarding_acknowledged = EXCLUDED.onboarding_acknowledged, accepted_by = EXCLUDED.accepted_by,
        accepted_at = EXCLUDED.accepted_at, artifact_verification_status = EXCLUDED.artifact_verification_status,
        artifact_verified_at = EXCLUDED.artifact_verified_at, artifact_verification_method = EXCLUDED.artifact_verification_method
      WHERE handoffs.organization_id = EXCLUDED.organization_id`, [
      handoff.projectId, this.organizationId, handoff.receivingOwnerId, handoff.status, handoff.adoptionPlanLink,
      handoff.supportEndDate, handoff.followUpDate, handoff.onboardingAcknowledged, handoff.acceptedBy, handoff.acceptedAt,
      handoff.artifactVerificationStatus || null, handoff.artifactVerifiedAt || null, handoff.artifactVerificationMethod || null
    ]);
  }

  async findOpenDecision(projectId) {
    const result = await this.query("SELECT id FROM decisions WHERE organization_id = $1 AND project_id = $2 AND status IN ('requested', 'approved')", [this.organizationId, projectId]);
    return result.rows?.[0] || null;
  }

  async insertDecision(decision) {
    await this.query(`INSERT INTO decisions (id, organization_id, project_id, outcome, rationale, status, requested_by, requested_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      decision.id, this.organizationId, decision.projectId, decision.outcome, decision.rationale, decision.status, decision.requestedBy, decision.requestedAt
    ]);
  }

  async insertApproval(approval) {
    await this.query(`INSERT INTO approvals (id, organization_id, decision_id, approver_id, approver_role, result, comment, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      approval.id, this.organizationId, approval.decisionId, approval.approverId, approval.approverRole, approval.result, approval.comment, approval.createdAt
    ]);
  }

  async rejectDecision(id, actorId, timestamp, projectId) {
    await this.query("UPDATE decisions SET status = 'rejected', finalized_by = $3, finalized_at = $4 WHERE organization_id = $1 AND id = $2", [this.organizationId, id, actorId, timestamp]);
    await this.updateProjectStage(projectId, stages.INCUBATING, actorId, timestamp);
  }

  async finalizeDecision(id, actorId, timestamp, projectId, stage, extensionIncrement, retentionUntilValue) {
    await this.query("UPDATE projects SET stage = $3, extension_count = extension_count + $4, updated_at = $5, updated_by = $6 WHERE organization_id = $1 AND id = $2", [this.organizationId, projectId, stage, extensionIncrement, timestamp, actorId]);
    await this.query("UPDATE decisions SET status = 'finalized', finalized_by = $3, finalized_at = $4, retention_classification = $5, retention_until = $6 WHERE organization_id = $1 AND id = $2", [this.organizationId, id, actorId, timestamp, retentionClassification, retentionUntilValue]);
  }

  async softDeleteProject(id, actorId, deletionReason, timestamp) {
    await this.query("UPDATE projects SET deleted_at = $3, deleted_by = $4, deletion_reason = $5, updated_at = $3, updated_by = $4 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL", [this.organizationId, id, timestamp, actorId, deletionReason]);
  }

  async restoreProject(id, actorId, timestamp) {
    await this.query("UPDATE projects SET deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, updated_at = $3, updated_by = $4 WHERE organization_id = $1 AND id = $2 AND deleted_at IS NOT NULL", [this.organizationId, id, timestamp, actorId]);
  }

  async appendAudit(actorId, action, entityType, entityId, before, after) {
    const timestamp = now();
    await this.query("SELECT pg_advisory_xact_lock(hashtext($1))", [this.organizationId]);
    const prior = await this.query("SELECT audit_sequence, event_hash FROM audit_events WHERE organization_id = $1 ORDER BY audit_sequence DESC LIMIT 1", [this.organizationId]);
    const auditSequence = Number(prior.rows?.[0]?.audit_sequence || 0) + 1;
    const previousHash = prior.rows?.[0]?.event_hash || auditGenesisHash;
    const eventHash = auditEventHash({ auditSequence, previousHash, actorId, action, entityType, entityId, before, after, createdAt: timestamp });
    await this.query(`INSERT INTO audit_events (id, organization_id, actor_id, action, entity_type, entity_id, before_summary, after_summary, created_at, retention_classification, retention_until, audit_sequence, previous_hash, event_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14)`, [
      randomUUID(), this.organizationId, actorId, action, entityType, entityId,
      before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), timestamp, retentionClassification, retentionUntil(timestamp), auditSequence, previousHash, eventHash
    ]);
  }
}

/** Authoritative PostgreSQL workflow adapter. Every mutation includes its audit event in one transaction. */
export class PostgresWorkflowAdapter {
  constructor({ queryable, organizationId, approvedArtifactOrigins = ["https://intranet.example"], directoryAdapter = new DisabledDirectoryAdapter(), artifactVerifier, workTrackingAdapter = new DisabledWorkTrackingAdapter(), calendarAdapter = new DisabledCalendarAdapter() } = {}) {
    if (!queryable || typeof queryable.query !== "function" || typeof queryable.connect !== "function") throw new TypeError("A PostgreSQL pool with connect() is required.");
    this.queryable = queryable;
    this.organizationId = requiredText(organizationId, "organizationId");
    this.reads = new PostgresReadAdapter({ queryable, organizationId: this.organizationId });
    this.approvedArtifactOrigins = new Set(approvedArtifactOrigins);
    this.directory = directoryAdapter;
    this.artifactVerifier = artifactVerifier || new ArtifactVerifier({ approvedOrigins: approvedArtifactOrigins });
    this.workTracking = workTrackingAdapter;
    this.calendar = calendarAdapter;
  }

  async transaction(work) {
    let client;
    try { client = await this.queryable.connect(); } catch { throw databaseUnavailable(); }
    try {
      await client.query("BEGIN");
      const result = await work(new PostgresTransaction(client, this.organizationId));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error instanceof WorkflowError ? error : databaseUnavailable();
    } finally { client.release?.(); }
  }

  getActorBySubject(subject, role) { return this.reads.getActorBySubject(subject, role); }
  listCycles() { return this.reads.listCycles(); }
  async listProjects() {
    return Promise.all((await this.reads.listProjects()).map(project => enrichProjectDirectoryContext(project, this.directory)));
  }
  async project(id) { return enrichProjectDirectoryContext(await this.reads.getProject(id), this.directory); }
  async getProjectIncludingDeleted(id) { return enrichProjectDirectoryContext(await this.reads.getProjectIncludingDeleted(id), this.directory); }
  async intakeDraft(actor, id) {
    const draft = await this.reads.getIntakeDraft(id);
    this.requireDraftAccess(actor, draft);
    return draft;
  }
  async listIntakeDrafts(actor) {
    requireRole(actor, draftAllowedRoles);
    return this.reads.listIntakeDrafts(actor.id);
  }
  async searchDirectoryPeople(actor, query) {
    requireRole(actor, draftAllowedRoles);
    const people = await this.directory.searchPeople(query);
    return people
      .filter(person => person.active)
      .map(person => ({ id: person.id, displayName: person.displayName, organization: person.organization, managerId: person.managerId, active: person.active }));
  }
  requireDraftAccess(actor, draft) {
    requireRole(actor, draftAllowedRoles);
    if (draft.ownerId !== actor.id && !draftCollaboratorIds(draft).includes(actor.id)) {
      throw new WorkflowError("FORBIDDEN", "You do not have access to this draft.", 403);
    }
  }
  async projectRetentionUntil(id) {
    const result = await this.reads.query("SELECT retention_until FROM decisions WHERE organization_id = $1 AND project_id = $2 AND status = 'finalized' AND retention_until IS NOT NULL ORDER BY retention_until DESC LIMIT 1", [this.organizationId, id]);
    return result.rows?.[0]?.retention_until || null;
  }
  async verifyAuditIntegrity() {
    const result = await this.reads.query("SELECT audit_sequence AS \"auditSequence\", previous_hash AS \"previousHash\", event_hash AS \"eventHash\", actor_id AS \"actorId\", action, entity_type AS \"entityType\", entity_id AS \"entityId\", before_summary AS before, after_summary AS after, created_at AS \"createdAt\" FROM audit_events WHERE organization_id = $1 ORDER BY audit_sequence", [this.organizationId]);
    return verifyAuditChain(result.rows || []);
  }
  listAuditEvents(limit) { return this.reads.listAuditEvents(limit); }
  health() { return this.reads.health(); }
  close() { return this.reads.close(); }

  async listFeatureFlags(actor) {
    requireRole(actor, [roles.ADMIN]);
    return this.reads.listFeatureFlags();
  }

  async requireFeatureEnabled(key) {
    const flag = await this.reads.getFeatureFlag(key);
    if (!(flag || { enabled: featureFlagDefaults[key] }).enabled) throw new WorkflowError("FEATURE_DISABLED", "This feature is not enabled for the tenant.", 403, { featureFlag: key });
  }

  async setFeatureFlag(actor, key, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const flagKey = String(key ?? "").trim();
    if (!knownFeatureFlag(flagKey)) throw new WorkflowError("UNKNOWN_FEATURE_FLAG", "Feature flag is not recognized.", 404);
    if (typeof input.enabled !== "boolean") throw new WorkflowError("INVALID_FEATURE_FLAG", "Feature flag enabled value must be boolean.", 422);
    const existing = await this.reads.getFeatureFlag(flagKey) || { key: flagKey, enabled: featureFlagDefaults[flagKey], updatedAt: null, updatedBy: null };
    const timestamp = now();
    const next = { key: flagKey, enabled: input.enabled, updatedAt: timestamp, updatedBy: actor.id };
    await this.transaction(async tx => {
      await tx.upsertFeatureFlag(next);
      await tx.appendAudit(actor.id, "feature_flag_updated", "feature_flag", flagKey, { enabled: existing.enabled }, { enabled: next.enabled });
    });
    return this.reads.getFeatureFlag(flagKey);
  }

  async listRoleAssignments(actor) {
    requireRole(actor, [roles.ADMIN]);
    return this.reads.listRoleAssignments();
  }

  async setRoleAssignment(actor, userId, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const targetUserId = String(userId ?? input.userId ?? "").trim();
    if (!targetUserId) throw new WorkflowError("INVALID_ROLE_ASSIGNMENT", "Role assignment requires a user id.", 422);
    await this.actor(targetUserId);
    const role = String(input.role ?? "").trim();
    if (!assignableRoles.includes(role)) throw new WorkflowError("INVALID_ROLE", "Assigned role is invalid.", 422);
    const active = input.active === undefined ? true : Boolean(input.active);
    if (targetUserId === actor.id && active && finalDecisionAuthorizationRoles.includes(role)) throw new WorkflowError("SELF_ROLE_ESCALATION", "Administrators cannot grant themselves final-decision authorization.", 403);
    const existing = await this.reads.getRoleAssignment(targetUserId);
    const timestamp = now();
    const next = { userId: targetUserId, role, active, assignedBy: actor.id, assignedAt: timestamp };
    await this.transaction(async tx => {
      await tx.upsertRoleAssignment(next);
      await tx.appendAudit(actor.id, "role_assignment_updated", "role_assignment", targetUserId, existing ? { role: existing.role, active: existing.active } : null, { role: next.role, active: next.active });
    });
    return this.reads.getRoleAssignment(targetUserId);
  }

  async createCycle(actor, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const cycle = { id: randomUUID(), ...normalizeCycleInput(input) };
    for (const userId of cycle.steeringGroupIds) await this.actor(userId);
    await this.transaction(async tx => {
      await tx.insertCycle(cycle);
      await tx.appendAudit(actor.id, "cycle_created", "cycle", cycle.id, null, { theme: cycle.theme, startsOn: cycle.startsOn, endsOn: cycle.endsOn, capacityUnits: cycle.capacityUnits, status: cycle.status });
    });
    return this.reads.getCycle(cycle.id);
  }

  async updateCycle(actor, id, input = {}) {
    requireRole(actor, [roles.ADMIN]);
    const existing = await this.reads.getCycle(id);
    const cycle = normalizeCycleInput(input, existing);
    for (const userId of cycle.steeringGroupIds) await this.actor(userId);
    await this.transaction(async tx => {
      await tx.updateCycle(id, cycle);
      await tx.appendAudit(actor.id, "cycle_updated", "cycle", id, { theme: existing.theme, startsOn: existing.startsOn, endsOn: existing.endsOn, capacityUnits: existing.capacityUnits, status: existing.status }, { theme: cycle.theme, startsOn: cycle.startsOn, endsOn: cycle.endsOn, capacityUnits: cycle.capacityUnits, status: cycle.status });
    });
    return this.reads.getCycle(id);
  }

  async actor(id) {
    const result = await this.reads.query("SELECT id FROM users WHERE organization_id = $1 AND id = $2 AND active = true", [this.organizationId, requiredText(id, "actor id")]);
    if (!result.rows?.[0]) throw new WorkflowError("UNAUTHENTICATED", "A valid authenticated user is required.", 401);
    return { id };
  }

  validateEvidenceLink(value) {
    this.artifactVerifier.validateAllowedUrl(value);
  }

  async verifyArtifactLink(value, context = {}) {
    return this.artifactVerifier.verifyLink(value, context);
  }

  validateFutureDate(value, label) {
    const date = new Date(`${value}T12:00:00`);
    if (!value || Number.isNaN(date.getTime()) || date <= new Date()) throw new WorkflowError("INVALID_DATE", `${label} must be in the future.`, 422);
  }

  async validateIntake(input) {
    const required = ["title", "originTeam", "users", "problem", "metric", "baseline", "target", "metricSource", "metricOwnerId", "sponsorId", "receivingOwnerId", "projectLeadId", "riskClassification"];
    const missing = required.filter(key => !String(input[key] ?? "").trim());
    if (missing.length) throw new WorkflowError("INVALID_INTAKE", "Required intake information is missing.", 422, { missing });
    if (!Number.isInteger(Number(input.potentialReach)) || Number(input.potentialReach) < 1) throw new WorkflowError("INVALID_REACH", "Potential company reach must be at least one team.", 422);
    if (Object.hasOwn(input, "capacityUnits") && (!Number.isInteger(Number(input.capacityUnits)) || Number(input.capacityUnits) < 1 || Number(input.capacityUnits) > 10)) throw new WorkflowError("INVALID_CAPACITY_UNITS", "Project capacity units must be between 1 and 10.", 422);
    if (input.transferDate && new Date(`${input.transferDate}T12:00:00`) <= new Date()) throw new WorkflowError("INVALID_TRANSFER_DATE", "Transfer target must be in the future.", 422);
    await this.actor(input.sponsorId); await this.actor(input.projectLeadId); await this.actor(input.metricOwnerId);
    await this.actor(input.receivingOwnerId);
    await requireActiveDirectoryPerson(this.directory, input.sponsorId, "Sponsor");
    await requireActiveDirectoryPerson(this.directory, input.receivingOwnerId, "Receiving owner");
    await requireActiveDirectoryPerson(this.directory, input.metricOwnerId, "Metric owner");
    await requireActiveDirectoryPerson(this.directory, input.projectLeadId, "Project lead");
    if (!input.adoptionGate || !input.evidenceGate) throw new WorkflowError("GATES_UNCONFIRMED", "Adoption and evidence gates must be confirmed before submission.", 422);
  }

  async createIntakeDraft(actor, input = {}) {
    requireRole(actor, draftAllowedRoles);
    const id = randomUUID();
    const timestamp = now();
    const collaborators = normalizeCollaboratorRecords(input);
    for (const collaborator of collaborators) {
      if (collaborator.userId === actor.id) throw new WorkflowError("INVALID_COLLABORATOR", "The draft owner does not need collaborator access.", 422);
      await this.actor(collaborator.userId);
    }
    const draft = {
      id, status: stages.DRAFT, ownerId: actor.id, collaborators, collaboratorIds: collaborators.map(collaborator => collaborator.userId),
      content: normalizeDraftContent(input.content || input),
      createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id
    };
    await this.transaction(async tx => {
      await tx.insertIntakeDraft(draft);
      for (const collaborator of collaborators) {
        await tx.insertIntakeDraftCollaborator(id, { ...collaborator, addedAt: timestamp, addedBy: actor.id });
        await tx.appendAudit(actor.id, "intake_draft_collaborator_added", "intake_draft_collaborator", `${id}:${collaborator.userId}`, null, { draftId: id, userId: collaborator.userId, permission: collaborator.permission });
      }
      await tx.appendAudit(actor.id, "intake_draft_created", "intake_draft", id, null, { status: stages.DRAFT });
    });
    return this.intakeDraft(actor, id);
  }

  async updateIntakeDraft(actor, id, input = {}) {
    const draft = await this.reads.getIntakeDraft(id);
    this.requireDraftAccess(actor, draft);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can be updated.", 409);
    if (Object.hasOwn(input, "ownerId") && input.ownerId !== draft.ownerId) throw new WorkflowError("FORBIDDEN", "Draft ownership cannot be changed.", 403);
    if (Object.hasOwn(input, "status") && input.status !== draft.status) throw new WorkflowError("FORBIDDEN", "Drafts cannot be submitted through the update endpoint.", 403);
    if (Object.hasOwn(input, "collaboratorIds") || Object.hasOwn(input, "collaborators")) throw new WorkflowError("COLLABORATOR_ENDPOINT_REQUIRED", "Use the collaborator endpoint to change draft collaborators.", 409);
    const content = { ...draft.content, ...normalizeDraftContent(input.content || input) };
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.updateIntakeDraft(id, { content, updatedAt: timestamp, updatedBy: actor.id });
      await tx.appendAudit(actor.id, "intake_draft_updated", "intake_draft", id, { updatedAt: draft.updatedAt }, { updatedAt: timestamp });
    });
    return this.intakeDraft(actor, id);
  }

  async addIntakeDraftCollaborator(actor, id, input = {}) {
    const draft = await this.reads.getIntakeDraft(id);
    requireRole(actor, draftAllowedRoles);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can change collaborators.", 409);
    if (draft.ownerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the draft owner can add collaborators.", 403);
    const collaborator = normalizeSingleCollaborator(input);
    if (collaborator.userId === draft.ownerId) throw new WorkflowError("INVALID_COLLABORATOR", "The draft owner does not need collaborator access.", 422);
    if (draftCollaboratorIds(draft).includes(collaborator.userId)) throw new WorkflowError("COLLABORATOR_EXISTS", "Draft collaborator already exists.", 409);
    await this.actor(collaborator.userId);
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertIntakeDraftCollaborator(id, { ...collaborator, addedAt: timestamp, addedBy: actor.id });
      await tx.updateIntakeDraft(id, { content: draft.content, updatedAt: timestamp, updatedBy: actor.id });
      await tx.appendAudit(actor.id, "intake_draft_collaborator_added", "intake_draft_collaborator", `${id}:${collaborator.userId}`, null, { draftId: id, userId: collaborator.userId, permission: collaborator.permission });
    });
    return this.intakeDraft(actor, id);
  }

  async removeIntakeDraftCollaborator(actor, id, collaboratorId) {
    const draft = await this.reads.getIntakeDraft(id);
    requireRole(actor, draftAllowedRoles);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can change collaborators.", 409);
    if (draft.ownerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the draft owner can remove collaborators.", 403);
    const userId = String(collaboratorId ?? "").trim();
    const collaborator = (draft.collaborators || []).find(item => item.userId === userId);
    if (!userId || !collaborator) throw new WorkflowError("NOT_FOUND", "Draft collaborator not found.", 404);
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.deleteIntakeDraftCollaborator(id, userId);
      await tx.updateIntakeDraft(id, { content: draft.content, updatedAt: timestamp, updatedBy: actor.id });
      await tx.appendAudit(actor.id, "intake_draft_collaborator_removed", "intake_draft_collaborator", `${id}:${userId}`, { draftId: id, userId, permission: collaborator.permission }, null);
    });
    return this.intakeDraft(actor, id);
  }

  async createIntake(actor, input) {
    requireRole(actor, intakeOwnerRoles);
    await this.validateIntake(input);
    const content = intakeRevisionContent(input);
    const id = randomUUID(); const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertProject({ id, cycleId: content.cycleId, title: content.title, stage: stages.SUBMITTED, originTeam: content.originTeam, users: content.users, potentialReach: content.potentialReach, problem: content.problem, metric: content.metric, baseline: content.baseline, target: content.target, metricSource: content.metricSource, metricOwnerId: content.metricOwnerId, sponsorId: content.sponsorId, receivingOwnerId: content.receivingOwnerId || null, projectLeadId: content.projectLeadId, riskClassification: content.riskClassification, transferDate: content.transferDate, sharedPlatformImpact: content.sharedPlatformImpact, capacityUnits: content.capacityUnits, createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id });
      await tx.insertIntakeRevision({ id: randomUUID(), projectId: id, revisionNumber: 1, content, submittedBy: actor.id, submittedAt: timestamp });
      await tx.appendAudit(actor.id, "intake_submitted", "project", id, null, { stage: stages.SUBMITTED, title: content.title, revisionNumber: 1 });
    });
    return this.project(id);
  }

  async submitIntakeDraft(actor, id) {
    requireRole(actor, intakeOwnerRoles);
    const draft = await this.reads.getIntakeDraft(id);
    if (draft.ownerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the draft owner can submit this intake.", 403);
    if (draft.status !== stages.DRAFT) throw new WorkflowError("INVALID_STATE", "Only draft intakes can be submitted.", 409);
    const input = draft.content || {};
    await this.validateIntake(input);
    const content = intakeRevisionContent(input);
    const projectId = randomUUID(); const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertProject({ id: projectId, cycleId: content.cycleId, title: content.title, stage: stages.SUBMITTED, originTeam: content.originTeam, users: content.users, potentialReach: content.potentialReach, problem: content.problem, metric: content.metric, baseline: content.baseline, target: content.target, metricSource: content.metricSource, metricOwnerId: content.metricOwnerId, sponsorId: content.sponsorId, receivingOwnerId: content.receivingOwnerId, projectLeadId: content.projectLeadId, riskClassification: content.riskClassification, transferDate: content.transferDate, sharedPlatformImpact: content.sharedPlatformImpact, capacityUnits: content.capacityUnits, createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id });
      await tx.insertIntakeRevision({ id: randomUUID(), projectId, revisionNumber: 1, content, submittedBy: actor.id, submittedAt: timestamp });
      await tx.updateIntakeDraftStatus(id, stages.SUBMITTED, timestamp, actor.id);
      await tx.appendAudit(actor.id, "intake_submitted", "project", projectId, null, { stage: stages.SUBMITTED, title: content.title, draftId: id, revisionNumber: 1 });
      await tx.appendAudit(actor.id, "intake_draft_submitted", "intake_draft", id, { status: stages.DRAFT }, { status: stages.SUBMITTED, projectId });
    });
    return this.project(projectId);
  }

  async listIntakeRevisions(actor, projectId) {
    const project = await this.project(projectId);
    this.requireTriageProject(project);
    this.requireTriageCommentAccess(actor, project);
    return this.reads.listIntakeRevisions(projectId);
  }

  async resubmitIntake(actor, projectId, input = {}) {
    await this.requireFeatureEnabled("intake_resubmission");
    requireRole(actor, intakeOwnerRoles);
    const project = await this.project(projectId);
    if (project.createdBy !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the intake owner can resubmit this intake.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged intakes can be resubmitted.", 409);
    await this.validateIntake(input);
    const content = intakeRevisionContent(input);
    const previous = (await this.reads.listIntakeRevisions(projectId)).at(-1) || null;
    const revisionNumber = Number(previous?.revisionNumber || 0) + 1;
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.updateProjectIntakeContent(projectId, content, actor.id, timestamp);
      await tx.insertIntakeRevision({ id: randomUUID(), projectId, revisionNumber, content, submittedBy: actor.id, submittedAt: timestamp });
      await tx.appendAudit(actor.id, "intake_resubmitted", "project", projectId, previous ? { revisionNumber: previous.revisionNumber } : null, { revisionNumber, changedFields: previous ? changedRevisionFields(previous.content, content).map(change => change.field) : [] });
    });
    return { project: await this.project(projectId), revision: await this.reads.getIntakeRevision(projectId, revisionNumber) };
  }

  async compareIntakeRevisions(actor, projectId, fromRevisionNumber, toRevisionNumber) {
    const project = await this.project(projectId);
    this.requireTriageProject(project);
    this.requireTriageCommentAccess(actor, project);
    const fromNumber = Number(fromRevisionNumber);
    const toNumber = Number(toRevisionNumber);
    if (!Number.isInteger(fromNumber) || !Number.isInteger(toNumber) || fromNumber < 1 || toNumber < 1) throw new WorkflowError("INVALID_REVISION", "Revision numbers must be positive integers.", 422);
    const from = await this.reads.getIntakeRevision(projectId, fromNumber);
    const to = await this.reads.getIntakeRevision(projectId, toNumber);
    if (!from || !to) throw new WorkflowError("REVISION_NOT_FOUND", "Intake revision not found.", 404);
    return { projectId, fromRevision: from, toRevision: to, changes: changedRevisionFields(from.content, to.content) };
  }

  async withdrawIntake(actor, id) {
    requireRole(actor, intakeOwnerRoles);
    const project = await this.project(id);
    if (project.createdBy !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the intake owner can withdraw it.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged intakes can be withdrawn.", 409);
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.softDeleteProject(id, actor.id, "withdrawn", timestamp);
      await tx.appendAudit(actor.id, "intake_withdrawn", "project", id, { stage: project.stage, deletedAt: null }, { deletionReason: "withdrawn", deletedAt: timestamp });
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

  async listTriageComments(actor, projectId) {
    const project = await this.project(projectId);
    this.requireTriageCommentAccess(actor, project);
    return this.reads.listTriageComments(projectId);
  }

  async addTriageComment(actor, projectId, input = {}) {
    const project = await this.project(projectId);
    this.requireTriageProject(project);
    this.requireTriageCommentAccess(actor, project);
    const id = randomUUID();
    const timestamp = now();
    const comment = normalizeTriageComment(input);
    await this.transaction(async tx => {
      await tx.insertTriageComment({ id, projectId, authorId: actor.id, kind: comment.kind, comment: comment.comment, createdAt: timestamp });
      await tx.appendAudit(actor.id, "triage_comment_added", "triage_comment", id, null, { projectId, kind: comment.kind });
    });
    return this.listTriageComments(actor, projectId);
  }

  async requestTriageInformation(actor, projectId, input = {}) {
    requireRole(actor, triageReviewerRoles);
    const project = await this.project(projectId);
    this.requireTriageProject(project);
    const id = randomUUID();
    const timestamp = now();
    const comment = normalizeTriageComment(input, "request_for_information");
    await this.transaction(async tx => {
      await tx.insertTriageComment({ id, projectId, authorId: actor.id, kind: comment.kind, comment: comment.comment, createdAt: timestamp });
      await tx.updateProjectTriageStatus(projectId, "information_requested", actor.id, timestamp);
      await tx.appendAudit(actor.id, "triage_information_requested", "triage_comment", id, { triageStatus: project.triageStatus || "open", stage: project.stage }, { triageStatus: "information_requested", stage: project.stage, projectId });
    });
    return { project: await this.project(projectId), comments: await this.listTriageComments(actor, projectId) };
  }

  async selectProject(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(id);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged projects can be selected.", 409);
    if (!project.receivingOwner) throw new WorkflowError("MISSING_RECEIVING_OWNER", "Selection requires a named receiving owner.", 409);
    if (project.directoryAssignments?.receivingOwner?.active !== true) throw new WorkflowError("RECEIVING_OWNER_INACTIVE", "Selection requires an active directory-verified receiving owner.", 409, { userId: project.receivingOwner.id });
    if (!project.adoptionAcknowledged) throw new WorkflowError("MISSING_ADOPTION_ACK", "Selection requires acknowledgement from the named receiving owner.", 409);
    const cycle = await this.reads.getCycle(project.cycleId);
    const usedCapacity = await this.transaction(tx => tx.cycleCapacityUsage(project.cycleId, [...cycleCapacityStages]));
    const remainingCapacity = Math.max(0, cycle.capacityUnits - usedCapacity);
    if (project.capacityUnits > remainingCapacity) throw new WorkflowError("CYCLE_CAPACITY_EXCEEDED", "Selection would exceed the cycle's approved capacity.", 409, { cycleId: project.cycleId, capacityUnits: project.capacityUnits, usedCapacity, remainingCapacity });
    await this.transaction(async tx => { await tx.updateProjectStage(id, stages.SELECTED, actor.id, now()); await tx.appendAudit(actor.id, "project_selected", "project", id, { stage: project.stage }, { stage: stages.SELECTED }); });
    return this.project(id);
  }

  async startIncubation(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(id);
    if (project.stage !== stages.SELECTED) throw new WorkflowError("INVALID_STATE", "Only selected projects can start incubation.", 409);
    await this.transaction(async tx => { await tx.updateProjectStage(id, stages.INCUBATING, actor.id, now()); await tx.appendAudit(actor.id, "incubation_started", "project", id, { stage: project.stage }, { stage: stages.INCUBATING }); });
    return this.project(id);
  }

  async acknowledgeAdoption(actor, projectId) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = await this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can acknowledge this adoption path.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Adoption acknowledgement must happen before selection.", 409);
    if (project.adoptionAcknowledged) throw new WorkflowError("ADOPTION_ALREADY_ACKNOWLEDGED", "This adoption path has already been acknowledged.", 409);
    const timestamp = now();
    await this.transaction(async tx => { await tx.acknowledgeProjectAdoption(projectId, actor.id, timestamp); await tx.appendAudit(actor.id, "adoption_acknowledged", "project", projectId, { adoptionAcknowledged: false }, { adoptionAcknowledged: true }); });
    return this.project(projectId);
  }

  async setGate(actor, projectId, key, input) {
    requireRole(actor, [roles.LAB_LEAD, roles.PLATFORM_REVIEWER, roles.ADMIN]);
    const project = await this.project(projectId);
    if (!String(key).match(/^[a-z_]+$/)) throw new WorkflowError("INVALID_GATE", "Gate key is invalid.", 422);
    if (key === "receiving_owner_ack") throw new WorkflowError("HANDOFF_REQUIRED", "Only the named receiving owner can complete the handoff acknowledgement.", 409);
    if (key === "metric_evidence") throw new WorkflowError("EVIDENCE_ENTRY_REQUIRED", "Metric evidence is completed only by recording a structured metric result.", 409);
    if (key === "reviews_complete") throw new WorkflowError("REVIEW_RECORD_REQUIRED", "Review completion is calculated from required review records.", 409);
    if (!["complete", "excepted", "incomplete"].includes(input.status)) throw new WorkflowError("INVALID_GATE_STATUS", "Gate status is invalid.", 422);
    if (input.status === "complete" && !String(input.evidenceLink ?? "").trim()) throw new WorkflowError("MISSING_EVIDENCE", "Completed gates require an approved evidence link.", 422);
    if (input.status === "excepted" && !String(input.exceptionReason ?? "").trim()) throw new WorkflowError("MISSING_EXCEPTION", "Excepted gates require a written risk acceptance.", 422);
    const verification = input.status === "complete" ? await this.verifyArtifactLink(input.evidenceLink, { entityType: "project_gate", projectId, key }) : null;
    const before = project.gates.find(gate => gate.key === key) || null; const timestamp = now();
    await this.transaction(async tx => {
      await tx.upsertGate({ projectId, key, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null, ...artifactVerificationFields(verification) });
      await tx.appendAudit(actor.id, "gate_updated", "project_gate", `${projectId}:${key}`, before, { key, status: input.status, artifactVerificationStatus: verification?.status || null });
      if (key === "delivery_kit" && input.status === "excepted") await tx.appendAudit(actor.id, "delivery_kit_exception_accepted", "project_gate", `${projectId}:${key}`, before, { exceptionReason: input.exceptionReason.trim() });
    });
    return this.project(projectId);
  }

  async addEvidence(actor, projectId, input) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(projectId);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can record evidence only for their assigned projects.", 403);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Evidence can be recorded only during incubation or decision review.", 409);
    if (!["metric_result", "user_feedback", "pilot_demo"].includes(input.evidenceType)) throw new WorkflowError("INVALID_EVIDENCE_TYPE", "Evidence type is invalid.", 422);
    if (!String(input.result ?? "").trim()) throw new WorkflowError("MISSING_EVIDENCE_RESULT", "Evidence requires a result summary.", 422);
    if (!Number.isInteger(Number(input.sampleSize)) || Number(input.sampleSize) < 1) throw new WorkflowError("INVALID_SAMPLE_SIZE", "Evidence requires a sample size of at least one.", 422);
    if (!["low", "medium", "high"].includes(input.confidence)) throw new WorkflowError("INVALID_CONFIDENCE", "Evidence confidence is invalid.", 422);
    const verification = await this.verifyArtifactLink(input.sourceLink, { entityType: "evidence", projectId, evidenceType: input.evidenceType });
    const observed = new Date(`${input.observedAt}T12:00:00`);
    if (!input.observedAt || Number.isNaN(observed.getTime()) || observed > new Date()) throw new WorkflowError("INVALID_OBSERVED_DATE", "Evidence date must be today or earlier.", 422);
    const id = randomUUID(); const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertEvidence({ id, projectId, evidenceType: input.evidenceType, result: input.result.trim(), sampleSize: Number(input.sampleSize), confidence: input.confidence, sourceLink: input.sourceLink.trim(), observedAt: input.observedAt, createdBy: actor.id, createdAt: timestamp, ...artifactVerificationFields(verification) });
      if (input.evidenceType === "metric_result") await tx.upsertGate({ projectId, key: "metric_evidence", status: "complete", evidenceLink: input.sourceLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null, ...artifactVerificationFields(verification) });
      await tx.appendAudit(actor.id, "evidence_recorded", "evidence", id, null, { projectId, evidenceType: input.evidenceType, confidence: input.confidence, artifactVerificationStatus: verification.status });
    });
    return this.project(projectId);
  }

  async setReview(actor, projectId, reviewType, input) {
    requireRole(actor, [roles.PLATFORM_REVIEWER, roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(projectId);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Reviews can be recorded only during incubation or decision review.", 409);
    if (!reviewTypes.includes(reviewType) || !project.reviewRequirements.includes(reviewType)) throw new WorkflowError("INVALID_REVIEW_TYPE", "This review is not required for the project risk classification.", 422);
    if (!["complete", "excepted", "incomplete"].includes(input.status)) throw new WorkflowError("INVALID_REVIEW_STATUS", "Review status is invalid.", 422);
    const verification = input.status === "complete" ? await this.verifyArtifactLink(input.evidenceLink, { entityType: "project_review", projectId, reviewType }) : null;
    if (input.status === "excepted" && !String(input.exceptionReason ?? "").trim()) throw new WorkflowError("MISSING_EXCEPTION", "An excepted review requires written risk acceptance.", 422);
    const before = project.reviews.find(review => review.reviewType === reviewType) || null; const timestamp = now();
    await this.transaction(async tx => {
      await tx.upsertReview({ projectId, reviewType, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null, ...artifactVerificationFields(verification) });
      const reviews = await tx.listReviews(projectId);
      const complete = project.reviewRequirements.every(type => reviews.some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status)));
      await tx.upsertGate({ projectId, key: "reviews_complete", status: complete ? "complete" : "incomplete", evidenceLink: complete ? input.evidenceLink?.trim() || null : null, completedBy: complete ? actor.id : null, completedAt: complete ? timestamp : null, exceptionReason: null, ...artifactVerificationFields(complete ? verification : null) });
      await tx.appendAudit(actor.id, "review_updated", "project_review", `${projectId}:${reviewType}`, before, { reviewType, status: input.status, reviewsComplete: complete, artifactVerificationStatus: verification?.status || null });
    });
    return this.project(projectId);
  }

  requireDeliveryKitWriteAccess(actor, project) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) {
      throw new WorkflowError("FORBIDDEN", "Project leads can update delivery-kit items only for their assigned projects.", 403);
    }
  }

  async listDeliveryKit(actor, projectId) {
    requireRole(actor, Object.values(roles));
    await this.project(projectId);
    return defaultDeliveryKitItems(projectId, await this.reads.query(
      `SELECT project_id AS "projectId", item_key AS "itemKey", status, owner_id AS "ownerId", evidence_link AS "evidenceLink",
        accepted_at AS "acceptedAt", accepted_by AS "acceptedBy", updated_at AS "updatedAt", updated_by AS "updatedBy",
        artifact_verification_status AS "artifactVerificationStatus", artifact_verified_at AS "artifactVerifiedAt",
        artifact_verification_method AS "artifactVerificationMethod"
       FROM delivery_kit_items WHERE organization_id = $1 AND project_id = $2 ORDER BY item_key`,
      [this.organizationId, projectId]
    ).then(result => result.rows || []));
  }

  async upsertDeliveryKitItem(actor, projectId, itemKey, input = {}) {
    const project = await this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const key = normalizeDeliveryKitItemKey(itemKey);
    const item = normalizeDeliveryKitInput(input);
    await this.actor(item.ownerId);
    const verification = item.evidenceLink ? await this.verifyArtifactLink(item.evidenceLink, { entityType: "delivery_kit_item", projectId, itemKey: key }) : null;
    const before = project.deliveryKit.find(existing => existing.itemKey === key) || null;
    const timestamp = now();
    const next = {
      projectId, itemKey: key, status: item.status, ownerId: item.ownerId, evidenceLink: item.evidenceLink,
      acceptedAt: item.status === "complete" ? timestamp : null, acceptedBy: item.status === "complete" ? actor.id : null,
      updatedAt: timestamp, updatedBy: actor.id,
      ...artifactVerificationFields(verification)
    };
    await this.transaction(async tx => {
      await tx.upsertDeliveryKitItem(next);
      await tx.appendAudit(actor.id, "delivery_kit_item_updated", "delivery_kit_item", `${projectId}:${key}`, before, { itemKey: key, status: next.status, ownerId: next.ownerId, artifactVerificationStatus: verification?.status || null });
    });
    return (await this.project(projectId)).deliveryKit.find(existing => existing.itemKey === key);
  }

  async deleteDeliveryKitItem(actor, projectId, itemKey) {
    const project = await this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const key = normalizeDeliveryKitItemKey(itemKey);
    const before = project.deliveryKit.find(existing => existing.itemKey === key) || null;
    await this.transaction(async tx => {
      await tx.deleteDeliveryKitItem(projectId, key);
      await tx.appendAudit(actor.id, "delivery_kit_item_deleted", "delivery_kit_item", `${projectId}:${key}`, before, null);
    });
    return (await this.project(projectId)).deliveryKit.find(existing => existing.itemKey === key);
  }

  async createOrLinkWorkItem(actor, projectId, input = {}) {
    await this.requireFeatureEnabled("work_tracking_integration");
    const project = await this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const before = await this.transaction(tx => tx.getProjectWorkItem(projectId));
    const verified = await this.workTracking.createOrLink(input, { projectId, actorId: actor.id });
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
    await this.transaction(async tx => {
      await tx.upsertProjectWorkItem(next);
      await tx.appendAudit(actor.id, before ? "work_item_linked" : "work_item_created", "project_work_item", projectId, before, {
        provider: next.provider, externalRef: next.externalRef, externalStatus: next.externalStatus, lastVerifiedAt: next.lastVerifiedAt
      });
    });
    return this.transaction(tx => tx.getProjectWorkItem(projectId));
  }

  async refreshWorkItem(actor, projectId) {
    await this.requireFeatureEnabled("work_tracking_integration");
    const project = await this.project(projectId);
    this.requireDeliveryKitWriteAccess(actor, project);
    const before = await this.transaction(tx => tx.getProjectWorkItem(projectId));
    if (!before) throw new WorkflowError("WORK_ITEM_NOT_FOUND", "Project does not have a linked work item.", 404);
    const verified = await this.workTracking.refresh(before, { projectId, actorId: actor.id });
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
    await this.transaction(async tx => {
      await tx.upsertProjectWorkItem(next);
      await tx.appendAudit(actor.id, "work_item_refreshed", "project_work_item", projectId, before, {
        provider: next.provider, externalRef: next.externalRef, externalStatus: next.externalStatus, lastVerifiedAt: next.lastVerifiedAt
      });
    });
    return this.transaction(tx => tx.getProjectWorkItem(projectId));
  }

  async listCalendarEvents(actor, projectId) {
    requireRole(actor, Object.values(roles));
    await this.project(projectId);
    return this.transaction(tx => tx.listProjectCalendarEvents(projectId));
  }

  async scheduleCalendarEvent(actor, projectId, input = {}) {
    await this.requireFeatureEnabled("calendar_integration");
    const project = await this.project(projectId);
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.PLATFORM_REVIEWER, roles.EXECUTIVE_SPONSOR, roles.RECEIVING_OWNER, roles.ADMIN]);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can schedule calendar events only for their assigned projects.", 403);
    if (actor.role === roles.RECEIVING_OWNER && project.receivingOwner?.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Receiving owners can schedule calendar events only for their assigned projects.", 403);
    const event = normalizeCalendarEventInput(input, project);
    const before = await this.transaction(tx => tx.getProjectCalendarEvent(projectId, event.eventKey));
    const verified = await this.calendar.createOrValidate({ ...event, eventUrl: event.externalUrl }, { projectId, actorId: actor.id, decisionId: event.decisionId });
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
    await this.transaction(async tx => {
      await tx.upsertProjectCalendarEvent(next);
      await tx.appendAudit(actor.id, "calendar_event_scheduled", "project_calendar_event", `${projectId}:${event.eventKey}`, before, {
        eventType: next.eventType, decisionId: next.decisionId, externalRef: next.externalRef, scheduledFor: next.scheduledFor, lastVerifiedAt: next.lastVerifiedAt
      });
    });
    return this.transaction(tx => tx.getProjectCalendarEvent(projectId, event.eventKey));
  }

  async listFellowAssignments(actor, filters = {}) {
    requireRole(actor, Object.values(roles));
    return this.transaction(tx => tx.listFellowAssignments({
      cycleId: String(filters.cycleId ?? "").trim() || null,
      projectId: String(filters.projectId ?? "").trim() || null
    }));
  }

  async createFellowAssignment(actor, input = {}) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const fellow = await requireActiveDirectoryPerson(this.directory, input.fellowId, "Fellow");
    const data = normalizeFellowAssignmentInput({ ...input, managerId: input.managerId || fellow.managerId });
    const project = await this.project(data.projectId);
    await this.reads.getCycle(data.cycleId);
    if (project.cycleId !== data.cycleId) throw new WorkflowError("FELLOW_ASSIGNMENT_SCOPE_MISMATCH", "Fellow assignment cycle must match the project cycle.", 422);
    await this.actor(data.fellowId); await this.actor(data.managerId);
    if (data.status === "active") throw new WorkflowError("MANAGER_ACK_REQUIRED", "Manager acknowledgement is required before a Fellow assignment can become active.", 409);
    const id = randomUUID(); const timestamp = now();
    const assignment = { id, ...data, status: data.status, managerAcknowledgedAt: null, managerAcknowledgedBy: null, createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id };
    await this.transaction(async tx => {
      await tx.insertFellowAssignment(assignment);
      await tx.appendAudit(actor.id, "fellow_assignment_created", "fellow_assignment", id, null, { cycleId: data.cycleId, projectId: data.projectId, fellowId: data.fellowId, status: assignment.status });
    });
    return this.transaction(tx => tx.getFellowAssignment(id));
  }

  async updateFellowAssignment(actor, id, input = {}) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const existing = await this.transaction(tx => tx.getFellowAssignment(id));
    const data = normalizeFellowAssignmentInput(input, existing);
    const project = await this.project(data.projectId);
    await this.reads.getCycle(data.cycleId);
    if (project.cycleId !== data.cycleId) throw new WorkflowError("FELLOW_ASSIGNMENT_SCOPE_MISMATCH", "Fellow assignment cycle must match the project cycle.", 422);
    await this.actor(data.fellowId); await this.actor(data.managerId);
    const managerAcknowledgedAt = existing.managerAcknowledgedAt && existing.managerId === data.managerId ? existing.managerAcknowledgedAt : null;
    const managerAcknowledgedBy = existing.managerAcknowledgedAt && existing.managerId === data.managerId ? existing.managerAcknowledgedBy : null;
    if (data.status === "active" && !managerAcknowledgedAt) throw new WorkflowError("MANAGER_ACK_REQUIRED", "Manager acknowledgement is required before a Fellow assignment can become active.", 409);
    const timestamp = now();
    const patch = { ...data, managerAcknowledgedAt, managerAcknowledgedBy, updatedAt: timestamp, updatedBy: actor.id };
    await this.transaction(async tx => {
      await tx.updateFellowAssignment(id, patch);
      await tx.appendAudit(actor.id, "fellow_assignment_updated", "fellow_assignment", id, { status: existing.status, managerId: existing.managerId }, { status: patch.status, managerId: patch.managerId });
    });
    return this.transaction(tx => tx.getFellowAssignment(id));
  }

  async acknowledgeFellowAssignment(actor, id) {
    const existing = await this.transaction(tx => tx.getFellowAssignment(id));
    if (existing.managerId !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the assigned Fellow manager can acknowledge this assignment.", 403);
    if (existing.status !== "proposed") throw new WorkflowError("INVALID_FELLOW_ASSIGNMENT_STATE", "Only proposed Fellow assignments can be acknowledged.", 409);
    const timestamp = now();
    const patch = { ...existing, status: "active", managerAcknowledgedAt: timestamp, managerAcknowledgedBy: actor.id, updatedAt: timestamp, updatedBy: actor.id };
    await this.transaction(async tx => {
      await tx.updateFellowAssignment(id, patch);
      await tx.appendAudit(actor.id, "fellow_assignment_acknowledged", "fellow_assignment", id, { status: existing.status }, { status: "active", managerAcknowledgedAt: timestamp });
    });
    return this.transaction(tx => tx.getFellowAssignment(id));
  }

  async acceptHandoff(actor, projectId, input) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = await this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can accept this handoff.", 403);
    if (!project.pendingDecision || project.pendingDecision.outcome !== outcomes.TRANSFER) throw new WorkflowError("INVALID_HANDOFF_STATE", "A transfer decision request is required before handoff acceptance.", 409);
    if (!input.onboardingAcknowledged) throw new WorkflowError("ONBOARDING_REQUIRED", "Receiving owner must acknowledge onboarding before accepting handoff.", 422);
    const verification = await this.verifyArtifactLink(input.adoptionPlanLink, { entityType: "handoff", projectId });
    this.validateFutureDate(input.supportEndDate, "Support end date"); this.validateFutureDate(input.followUpDate, "Follow-up date");
    const timestamp = now();
    await this.transaction(async tx => {
      const existing = await tx.getHandoff(projectId);
      if (existing?.status === "accepted") throw new WorkflowError("HANDOFF_ALREADY_ACCEPTED", "This handoff has already been accepted.", 409);
      await tx.upsertHandoff({ projectId, receivingOwnerId: actor.id, status: "accepted", adoptionPlanLink: input.adoptionPlanLink.trim(), supportEndDate: input.supportEndDate, followUpDate: input.followUpDate, onboardingAcknowledged: true, acceptedBy: actor.id, acceptedAt: timestamp, ...artifactVerificationFields(verification) });
      for (const key of ["receiving_owner_ack", "support_plan", "follow_up_scheduled"]) await tx.upsertGate({ projectId, key, status: "complete", evidenceLink: input.adoptionPlanLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null, ...artifactVerificationFields(verification) });
      await tx.appendAudit(actor.id, "handoff_accepted", "handoff", projectId, existing || null, { status: "accepted", supportEndDate: input.supportEndDate, followUpDate: input.followUpDate, artifactVerificationStatus: verification.status });
    });
    return this.project(projectId);
  }

  async getDecision(id) {
    const result = await this.reads.query("SELECT id, project_id, outcome, rationale, status, requested_by, requested_at, finalized_by, finalized_at FROM decisions WHERE organization_id = $1 AND id = $2", [this.organizationId, id]);
    const row = result.rows?.[0];
    if (!row) throw new WorkflowError("NOT_FOUND", "Decision not found.", 404);
    return { id: row.id, projectId: row.project_id, outcome: row.outcome, rationale: row.rationale, status: row.status, requestedBy: row.requested_by, requestedAt: row.requested_at, finalizedBy: row.finalized_by, finalizedAt: row.finalized_at };
  }

  async listApprovals(id) {
    const result = await this.reads.query("SELECT approver_id AS \"approverId\", approver_role AS \"approverRole\", result, comment, created_at AS \"createdAt\" FROM approvals WHERE organization_id = $1 AND decision_id = $2 ORDER BY created_at", [this.organizationId, id]);
    return result.rows || [];
  }

  async decision(id) {
    const decision = await this.getDecision(id); const project = await this.project(decision.projectId);
    return { ...decision, approvals: await this.listApprovals(id), missingGates: missingGates(decision.outcome, project.gates, project), requiredApprovers: requiredApproverRoles(decision.outcome, project) };
  }

  async requestDecision(actor, projectId, input) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(projectId);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can request decisions only for their assigned projects.", 403);
    requireTransition(project, input.outcome);
    if (!String(input.rationale ?? "").trim()) throw new WorkflowError("MISSING_RATIONALE", "A decision rationale is required.", 422);
    const id = randomUUID(); const timestamp = now();
    await this.transaction(async tx => {
      if (await tx.findOpenDecision(projectId)) throw new WorkflowError("PENDING_DECISION", "A decision is already awaiting approval.", 409);
      await tx.insertDecision({ id, projectId, outcome: input.outcome, rationale: input.rationale.trim(), status: "requested", requestedBy: actor.id, requestedAt: timestamp });
      await tx.updateProjectStage(projectId, stages.DECISION_PENDING, actor.id, timestamp);
      await tx.appendAudit(actor.id, "decision_requested", "decision", id, null, { projectId, outcome: input.outcome, missingGates: missingGates(input.outcome, project.gates, project) });
    });
    return this.decision(id);
  }

  async approveDecision(actor, id, input) {
    const decision = await this.decision(id);
    if (decision.status !== "requested") throw new WorkflowError("INVALID_DECISION_STATE", "Only requested decisions can be approved.", 409);
    if (decision.requestedBy === actor.id) throw new WorkflowError("SELF_APPROVAL", "A requester cannot approve their own decision.", 403);
    if (!decision.requiredApprovers.includes(actor.role)) throw new WorkflowError("FORBIDDEN", "You are not a required approver for this decision.", 403);
    if (!["approved", "rejected"].includes(input.result)) throw new WorkflowError("INVALID_APPROVAL", "Approval result is invalid.", 422);
    if (!String(input.comment ?? "").trim()) throw new WorkflowError("MISSING_APPROVAL_COMMENT", "An approval comment is required.", 422);
    if (decision.approvals.some(approval => approval.approverRole === actor.role)) throw new WorkflowError("DUPLICATE_APPROVAL", "This approval role has already responded.", 409);
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertApproval({ id: randomUUID(), decisionId: id, approverId: actor.id, approverRole: actor.role, result: input.result, comment: input.comment.trim(), createdAt: timestamp });
      if (input.result === "rejected") { await tx.rejectDecision(id, actor.id, timestamp, decision.projectId); await tx.appendAudit(actor.id, "decision_rejected", "decision", id, { stage: stages.DECISION_PENDING }, { stage: stages.INCUBATING, role: actor.role, comment: input.comment.trim() }); }
      else await tx.appendAudit(actor.id, "decision_approved", "decision", id, null, { result: input.result, role: actor.role });
    });
    return this.decision(id);
  }

  async finalizeDecision(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const decision = await this.decision(id);
    if (decision.status !== "requested") throw new WorkflowError("INVALID_DECISION_STATE", "Only requested decisions can be finalized.", 409);
    const rejected = decision.approvals.find(approval => approval.result === "rejected");
    if (rejected) throw new WorkflowError("DECISION_REJECTED", "A required approver rejected this decision.", 409, { rejectedBy: rejected.approverRole });
    const approvedRoles = new Set(decision.approvals.filter(approval => approval.result === "approved").map(approval => approval.approverRole));
    const missingApprovals = decision.requiredApprovers.filter(role => !approvedRoles.has(role));
    if (missingApprovals.length) throw new WorkflowError("MISSING_APPROVALS", "Required approvals are incomplete.", 409, { missingApprovals });
    if (decision.missingGates.length) throw new WorkflowError("MISSING_GATES", "Decision gates are incomplete.", 409, { missingGates: decision.missingGates });
    const project = await this.project(decision.projectId); const stage = finalStage(decision.outcome); const timestamp = now();
    await this.transaction(async tx => { await tx.finalizeDecision(id, actor.id, timestamp, project.id, stage, decision.outcome === outcomes.EXTEND ? 1 : 0, retentionUntil(timestamp)); await tx.appendAudit(actor.id, "decision_finalized", "decision", id, { stage: project.stage }, { stage, outcome: decision.outcome }); });
    return { decision: await this.decision(id), project: await this.project(project.id) };
  }

  async deleteProject(actor, id, deletionReason) {
    requireRole(actor, [roles.ADMIN]);
    const project = await this.getProjectIncludingDeleted(id);
    if (project.deletedAt) throw new WorkflowError("ALREADY_DELETED", "Project is already deleted.", 409);
    if (!retentionExpired(await this.projectRetentionUntil(id))) throw new WorkflowError("RETENTION_ACTIVE", "A retained final decision prevents ordinary deletion.", 409);
    if (!deletionReasons.includes(deletionReason)) throw new WorkflowError("INVALID_DELETION_REASON", "Deletion reason is invalid.", 422);
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.softDeleteProject(id, actor.id, deletionReason, timestamp);
      await tx.appendAudit(actor.id, "project_deleted", "project", id, { deletedAt: null }, { deletionReason, deletedAt: timestamp });
    });
  }

  async restoreProject(actor, id) {
    requireRole(actor, [roles.ADMIN]);
    const project = await this.getProjectIncludingDeleted(id);
    if (!project.deletedAt) throw new WorkflowError("NOT_DELETED", "Project is not deleted.", 409);
    const timestamp = now();
    await this.transaction(async tx => {
      await tx.restoreProject(id, actor.id, timestamp);
      await tx.appendAudit(actor.id, "project_restored", "project", id, { deletedAt: project.deletedAt, deletionReason: project.deletionReason }, { deletedAt: null });
    });
    return this.project(id);
  }
}

export function createPostgresWorkflowAdapter({ databaseUrl, organizationId, approvedArtifactOrigins, directoryAdapter, artifactVerifier, workTrackingAdapter, calendarAdapter, PoolConstructor = Pool } = {}) {
  return new PostgresWorkflowAdapter({ queryable: new PoolConstructor({ connectionString: requiredText(databaseUrl, "databaseUrl") }), organizationId, approvedArtifactOrigins, directoryAdapter, artifactVerifier, workTrackingAdapter, calendarAdapter });
}
