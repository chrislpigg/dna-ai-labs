import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresReadAdapter } from "./postgres-read-adapter.mjs";
import { deletionReasons } from "./workflow-service.mjs";
import { retentionClassification, retentionExpired, retentionUntil } from "./retention-policy.mjs";
import { auditEventHash, auditGenesisHash, verifyAuditChain } from "./audit-integrity.mjs";
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
    "sharedPlatformImpact", "adoptionGate", "evidenceGate", "cycleId"
  ];
  return Object.fromEntries(allowedKeys.filter(key => Object.hasOwn(input, key)).map(key => {
    const value = input[key];
    return [key, typeof value === "string" ? value.trim() : value];
  }));
}

const collaboratorPermissions = Object.freeze(["edit"]);

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
      shared_platform_impact, created_at, created_by, updated_at, updated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`, [
      project.id, this.organizationId, project.cycleId, project.title, project.stage, project.originTeam, project.users,
      project.potentialReach, project.problem, project.metric, project.baseline, project.target, project.metricSource,
      project.metricOwnerId, project.sponsorId, project.receivingOwnerId, project.projectLeadId, project.riskClassification,
      project.transferDate, project.sharedPlatformImpact, project.createdAt, project.createdBy, project.updatedAt, project.updatedBy
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

  async updateProjectStage(id, stage, actorId, timestamp) {
    await this.query("UPDATE projects SET stage = $3, updated_at = $4, updated_by = $5 WHERE organization_id = $1 AND id = $2", [this.organizationId, id, stage, timestamp, actorId]);
  }

  async acknowledgeProjectAdoption(projectId, actorId, timestamp) {
    await this.query("UPDATE projects SET adoption_acknowledged_by = $3, adoption_acknowledged_at = $4, updated_at = $4, updated_by = $3 WHERE organization_id = $1 AND id = $2", [this.organizationId, projectId, actorId, timestamp]);
  }

  async upsertGate(gate) {
    await this.query(`INSERT INTO project_gates (project_id, organization_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id, gate_key) DO UPDATE SET status = EXCLUDED.status, evidence_link = EXCLUDED.evidence_link,
        completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at, exception_reason = EXCLUDED.exception_reason
      WHERE project_gates.organization_id = EXCLUDED.organization_id`, [
      gate.projectId, this.organizationId, gate.key, gate.status, gate.evidenceLink, gate.completedBy, gate.completedAt, gate.exceptionReason
    ]);
  }

  async insertEvidence(evidence) {
    await this.query(`INSERT INTO evidence_entries (id, organization_id, project_id, evidence_type, result, sample_size, confidence, source_link, observed_at, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
      evidence.id, this.organizationId, evidence.projectId, evidence.evidenceType, evidence.result, evidence.sampleSize,
      evidence.confidence, evidence.sourceLink, evidence.observedAt, evidence.createdBy, evidence.createdAt
    ]);
  }

  async upsertReview(review) {
    await this.query(`INSERT INTO project_reviews (project_id, organization_id, review_type, status, evidence_link, completed_by, completed_at, exception_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id, review_type) DO UPDATE SET status = EXCLUDED.status, evidence_link = EXCLUDED.evidence_link,
        completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at, exception_reason = EXCLUDED.exception_reason
      WHERE project_reviews.organization_id = EXCLUDED.organization_id`, [
      review.projectId, this.organizationId, review.reviewType, review.status, review.evidenceLink, review.completedBy, review.completedAt, review.exceptionReason
    ]);
  }

  async listReviews(projectId) {
    const result = await this.query("SELECT review_type AS \"reviewType\", status FROM project_reviews WHERE organization_id = $1 AND project_id = $2", [this.organizationId, projectId]);
    return result.rows || [];
  }

  async getHandoff(projectId) {
    const result = await this.query(`SELECT project_id AS "projectId", receiving_owner_id AS "receivingOwnerId", status,
      adoption_plan_link AS "adoptionPlanLink", support_end_date AS "supportEndDate", follow_up_date AS "followUpDate",
      onboarding_acknowledged AS "onboardingAcknowledged", accepted_by AS "acceptedBy", accepted_at AS "acceptedAt"
      FROM handoffs WHERE organization_id = $1 AND project_id = $2`, [this.organizationId, projectId]);
    const handoff = result.rows?.[0];
    return handoff ? { ...handoff, onboardingAcknowledged: Boolean(handoff.onboardingAcknowledged) } : null;
  }

  async upsertHandoff(handoff) {
    await this.query(`INSERT INTO handoffs (project_id, organization_id, receiving_owner_id, status, adoption_plan_link, support_end_date, follow_up_date, onboarding_acknowledged, accepted_by, accepted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (project_id) DO UPDATE SET status = EXCLUDED.status, adoption_plan_link = EXCLUDED.adoption_plan_link,
        support_end_date = EXCLUDED.support_end_date, follow_up_date = EXCLUDED.follow_up_date,
        onboarding_acknowledged = EXCLUDED.onboarding_acknowledged, accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at
      WHERE handoffs.organization_id = EXCLUDED.organization_id`, [
      handoff.projectId, this.organizationId, handoff.receivingOwnerId, handoff.status, handoff.adoptionPlanLink,
      handoff.supportEndDate, handoff.followUpDate, handoff.onboardingAcknowledged, handoff.acceptedBy, handoff.acceptedAt
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
  constructor({ queryable, organizationId, approvedArtifactOrigins = ["https://intranet.example"] } = {}) {
    if (!queryable || typeof queryable.query !== "function" || typeof queryable.connect !== "function") throw new TypeError("A PostgreSQL pool with connect() is required.");
    this.queryable = queryable;
    this.organizationId = requiredText(organizationId, "organizationId");
    this.reads = new PostgresReadAdapter({ queryable, organizationId: this.organizationId });
    this.approvedArtifactOrigins = new Set(approvedArtifactOrigins);
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
  listProjects() { return this.reads.listProjects(); }
  project(id) { return this.reads.getProject(id); }
  getProjectIncludingDeleted(id) { return this.reads.getProjectIncludingDeleted(id); }
  async intakeDraft(actor, id) {
    const draft = await this.reads.getIntakeDraft(id);
    this.requireDraftAccess(actor, draft);
    return draft;
  }
  async listIntakeDrafts(actor) {
    requireRole(actor, draftAllowedRoles);
    return this.reads.listIntakeDrafts(actor.id);
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

  async actor(id) {
    const result = await this.reads.query("SELECT id FROM users WHERE organization_id = $1 AND id = $2 AND active = true", [this.organizationId, requiredText(id, "actor id")]);
    if (!result.rows?.[0]) throw new WorkflowError("UNAUTHENTICATED", "A valid authenticated user is required.", 401);
    return { id };
  }

  validateEvidenceLink(value) {
    let url;
    try { url = new URL(value); } catch { throw new WorkflowError("INVALID_EVIDENCE_LINK", "Evidence must be a valid approved URL.", 422); }
    if (!this.approvedArtifactOrigins.has(url.origin)) throw new WorkflowError("UNAPPROVED_EVIDENCE_LINK", "Evidence must link to an approved internal system.", 422);
  }

  validateFutureDate(value, label) {
    const date = new Date(`${value}T12:00:00`);
    if (!value || Number.isNaN(date.getTime()) || date <= new Date()) throw new WorkflowError("INVALID_DATE", `${label} must be in the future.`, 422);
  }

  async validateIntake(input) {
    const required = ["title", "originTeam", "users", "problem", "metric", "baseline", "target", "metricSource", "metricOwnerId", "sponsorId", "projectLeadId", "riskClassification"];
    const missing = required.filter(key => !String(input[key] ?? "").trim());
    if (missing.length) throw new WorkflowError("INVALID_INTAKE", "Required intake information is missing.", 422, { missing });
    if (!Number.isInteger(Number(input.potentialReach)) || Number(input.potentialReach) < 1) throw new WorkflowError("INVALID_REACH", "Potential company reach must be at least one team.", 422);
    if (input.transferDate && new Date(`${input.transferDate}T12:00:00`) <= new Date()) throw new WorkflowError("INVALID_TRANSFER_DATE", "Transfer target must be in the future.", 422);
    await this.actor(input.sponsorId); await this.actor(input.projectLeadId); await this.actor(input.metricOwnerId);
    if (input.receivingOwnerId) await this.actor(input.receivingOwnerId);
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
    requireRole(actor, [roles.SUBMITTER, roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    await this.validateIntake(input);
    const id = randomUUID(); const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertProject({ id, cycleId: input.cycleId || "cycle-2026-q3", title: input.title.trim(), stage: stages.SUBMITTED, originTeam: input.originTeam.trim(), users: input.users.trim(), potentialReach: Number(input.potentialReach), problem: input.problem.trim(), metric: input.metric.trim(), baseline: input.baseline.trim(), target: input.target.trim(), metricSource: input.metricSource.trim(), metricOwnerId: input.metricOwnerId, sponsorId: input.sponsorId, receivingOwnerId: input.receivingOwnerId || null, projectLeadId: input.projectLeadId, riskClassification: input.riskClassification, transferDate: input.transferDate || null, sharedPlatformImpact: Boolean(input.sharedPlatformImpact), createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id });
      await tx.appendAudit(actor.id, "intake_submitted", "project", id, null, { stage: stages.SUBMITTED, title: input.title.trim() });
    });
    return this.project(id);
  }

  async selectProject(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(id);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged projects can be selected.", 409);
    if (!project.receivingOwner) throw new WorkflowError("MISSING_RECEIVING_OWNER", "Selection requires a named receiving owner.", 409);
    if (!project.adoptionAcknowledged) throw new WorkflowError("MISSING_ADOPTION_ACK", "Selection requires acknowledgement from the named receiving owner.", 409);
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
    if (input.status === "complete") this.validateEvidenceLink(input.evidenceLink);
    const before = project.gates.find(gate => gate.key === key) || null; const timestamp = now();
    await this.transaction(async tx => { await tx.upsertGate({ projectId, key, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null }); await tx.appendAudit(actor.id, "gate_updated", "project_gate", `${projectId}:${key}`, before, { key, status: input.status }); });
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
    this.validateEvidenceLink(input.sourceLink);
    const observed = new Date(`${input.observedAt}T12:00:00`);
    if (!input.observedAt || Number.isNaN(observed.getTime()) || observed > new Date()) throw new WorkflowError("INVALID_OBSERVED_DATE", "Evidence date must be today or earlier.", 422);
    const id = randomUUID(); const timestamp = now();
    await this.transaction(async tx => {
      await tx.insertEvidence({ id, projectId, evidenceType: input.evidenceType, result: input.result.trim(), sampleSize: Number(input.sampleSize), confidence: input.confidence, sourceLink: input.sourceLink.trim(), observedAt: input.observedAt, createdBy: actor.id, createdAt: timestamp });
      if (input.evidenceType === "metric_result") await tx.upsertGate({ projectId, key: "metric_evidence", status: "complete", evidenceLink: input.sourceLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null });
      await tx.appendAudit(actor.id, "evidence_recorded", "evidence", id, null, { projectId, evidenceType: input.evidenceType, confidence: input.confidence });
    });
    return this.project(projectId);
  }

  async setReview(actor, projectId, reviewType, input) {
    requireRole(actor, [roles.PLATFORM_REVIEWER, roles.LAB_LEAD, roles.ADMIN]);
    const project = await this.project(projectId);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Reviews can be recorded only during incubation or decision review.", 409);
    if (!reviewTypes.includes(reviewType) || !project.reviewRequirements.includes(reviewType)) throw new WorkflowError("INVALID_REVIEW_TYPE", "This review is not required for the project risk classification.", 422);
    if (!["complete", "excepted", "incomplete"].includes(input.status)) throw new WorkflowError("INVALID_REVIEW_STATUS", "Review status is invalid.", 422);
    if (input.status === "complete") this.validateEvidenceLink(input.evidenceLink);
    if (input.status === "excepted" && !String(input.exceptionReason ?? "").trim()) throw new WorkflowError("MISSING_EXCEPTION", "An excepted review requires written risk acceptance.", 422);
    const before = project.reviews.find(review => review.reviewType === reviewType) || null; const timestamp = now();
    await this.transaction(async tx => {
      await tx.upsertReview({ projectId, reviewType, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null });
      const reviews = await tx.listReviews(projectId);
      const complete = project.reviewRequirements.every(type => reviews.some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status)));
      await tx.upsertGate({ projectId, key: "reviews_complete", status: complete ? "complete" : "incomplete", evidenceLink: complete ? input.evidenceLink?.trim() || null : null, completedBy: complete ? actor.id : null, completedAt: complete ? timestamp : null, exceptionReason: null });
      await tx.appendAudit(actor.id, "review_updated", "project_review", `${projectId}:${reviewType}`, before, { reviewType, status: input.status, reviewsComplete: complete });
    });
    return this.project(projectId);
  }

  async acceptHandoff(actor, projectId, input) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = await this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can accept this handoff.", 403);
    if (!project.pendingDecision || project.pendingDecision.outcome !== outcomes.TRANSFER) throw new WorkflowError("INVALID_HANDOFF_STATE", "A transfer decision request is required before handoff acceptance.", 409);
    if (!input.onboardingAcknowledged) throw new WorkflowError("ONBOARDING_REQUIRED", "Receiving owner must acknowledge onboarding before accepting handoff.", 422);
    this.validateEvidenceLink(input.adoptionPlanLink); this.validateFutureDate(input.supportEndDate, "Support end date"); this.validateFutureDate(input.followUpDate, "Follow-up date");
    const timestamp = now();
    await this.transaction(async tx => {
      const existing = await tx.getHandoff(projectId);
      if (existing?.status === "accepted") throw new WorkflowError("HANDOFF_ALREADY_ACCEPTED", "This handoff has already been accepted.", 409);
      await tx.upsertHandoff({ projectId, receivingOwnerId: actor.id, status: "accepted", adoptionPlanLink: input.adoptionPlanLink.trim(), supportEndDate: input.supportEndDate, followUpDate: input.followUpDate, onboardingAcknowledged: true, acceptedBy: actor.id, acceptedAt: timestamp });
      for (const key of ["receiving_owner_ack", "support_plan", "follow_up_scheduled"]) await tx.upsertGate({ projectId, key, status: "complete", evidenceLink: input.adoptionPlanLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null });
      await tx.appendAudit(actor.id, "handoff_accepted", "handoff", projectId, existing || null, { status: "accepted", supportEndDate: input.supportEndDate, followUpDate: input.followUpDate });
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
    return { ...decision, approvals: await this.listApprovals(id), missingGates: missingGates(decision.outcome, project.gates), requiredApprovers: requiredApproverRoles(decision.outcome, project) };
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
      await tx.appendAudit(actor.id, "decision_requested", "decision", id, null, { projectId, outcome: input.outcome, missingGates: missingGates(input.outcome, project.gates) });
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

export function createPostgresWorkflowAdapter({ databaseUrl, organizationId, approvedArtifactOrigins, PoolConstructor = Pool } = {}) {
  return new PostgresWorkflowAdapter({ queryable: new PoolConstructor({ connectionString: requiredText(databaseUrl, "databaseUrl") }), organizationId, approvedArtifactOrigins });
}
