import { Pool } from "pg";
import { missingGates, requiredApproverRoles, requiredReviewTypes, WorkflowError } from "./workflow-policy.mjs";
import { featureFlagDefaults } from "./feature-flags.mjs";
import { defaultDeliveryKitItems } from "./delivery-kit.mjs";

function requiredText(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function asRows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function dateValue(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function databaseUnavailable() {
  return new WorkflowError("DATABASE_UNAVAILABLE", "The authoritative database is unavailable.", 503);
}

function appendByProject(entries, projectId, value) {
  const values = entries.get(projectId) || [];
  values.push(value);
  entries.set(projectId, values);
}

function followUpStatus(followUp) {
  if (!followUp) return null;
  if (followUp.status !== "pending") return followUp.status;
  return new Date(`${followUp.dueOn}T23:59:59.999Z`) < new Date() ? "overdue" : "pending";
}

/**
 * Tenant-scoped, read-only PostgreSQL adapter. Write paths intentionally stay
 * out of this adapter until they can be committed with their audit event in a
 * single transaction.
 */
export class PostgresReadAdapter {
  constructor({ queryable, organizationId } = {}) {
    if (!queryable || typeof queryable.query !== "function") throw new TypeError("A PostgreSQL queryable is required.");
    this.queryable = queryable;
    this.organizationId = requiredText(organizationId, "organizationId");
  }

  async query(sql, values) {
    try {
      return await this.queryable.query(sql, values);
    } catch {
      throw databaseUnavailable();
    }
  }

  async getActorBySubject(subject, role) {
    const verifiedSubject = requiredText(subject, "subject");
    const result = await this.query(
      "SELECT id FROM users WHERE organization_id = $1 AND subject_ref = $2 AND active = true",
      [this.organizationId, verifiedSubject]
    );
    const user = asRows(result)[0];
    if (!user) throw new WorkflowError("UNAUTHENTICATED", "A valid authenticated user is required.", 401);
    return { id: user.id, name: "Verified user", role };
  }

  async listUsers() {
    const result = await this.query(
      `SELECT users.id, COALESCE(role_assignments.assigned_role, users.role) AS role
       FROM users
       LEFT JOIN role_assignments ON role_assignments.organization_id = users.organization_id
        AND role_assignments.user_id = users.id AND role_assignments.active = true
       WHERE users.organization_id = $1 AND users.active = true
       ORDER BY users.id`,
      [this.organizationId]
    );
    return asRows(result);
  }

  async getProject(projectId) {
    const projects = await this.listProjects({ projectId });
    if (!projects.length) throw new WorkflowError("NOT_FOUND", "Project not found.", 404);
    return projects[0];
  }

  async getProjectIncludingDeleted(projectId) {
    const projects = await this.listProjects({ projectId, includeDeleted: true });
    if (!projects.length) throw new WorkflowError("NOT_FOUND", "Project not found.", 404);
    return projects[0];
  }

  serializeCycle(row) {
    return {
      id: row.id,
      name: row.name,
      theme: row.theme,
      startsOn: dateValue(row.starts_on),
      endsOn: dateValue(row.ends_on),
      capacityUnits: row.capacity_units,
      steeringGroupIds: Array.isArray(row.steering_group_ids) ? row.steering_group_ids : [],
      status: row.status
    };
  }

  async listCycles() {
    const result = await this.query(
      "SELECT id, name, theme, starts_on, ends_on, capacity_units, steering_group_ids, status FROM cycles WHERE organization_id = $1 ORDER BY starts_on DESC, id",
      [this.organizationId]
    );
    return asRows(result).map(row => this.serializeCycle(row));
  }

  async getCycle(id) {
    const result = await this.query(
      "SELECT id, name, theme, starts_on, ends_on, capacity_units, steering_group_ids, status FROM cycles WHERE organization_id = $1 AND id = $2",
      [this.organizationId, requiredText(id, "cycle id")]
    );
    const row = asRows(result)[0];
    if (!row) throw new WorkflowError("NOT_FOUND", "Cycle not found.", 404);
    return this.serializeCycle(row);
  }

  async listFeatureFlags() {
    const result = await this.query(
      "SELECT flag_key, enabled, updated_at, updated_by FROM feature_flags WHERE organization_id = $1 ORDER BY flag_key",
      [this.organizationId]
    );
    const stored = new Map(asRows(result).map(row => [row.flag_key, {
      key: row.flag_key, enabled: Boolean(row.enabled), updatedAt: dateValue(row.updated_at), updatedBy: row.updated_by
    }]));
    return Object.entries(featureFlagDefaults).map(([key, enabled]) => stored.get(key) || { key, enabled, updatedAt: null, updatedBy: null });
  }

  async getFeatureFlag(key) {
    return (await this.listFeatureFlags()).find(flag => flag.key === key) || null;
  }

  serializeRoleAssignment(row) {
    return {
      userId: row.user_id,
      role: row.assigned_role,
      active: Boolean(row.active),
      assignedBy: row.assigned_by,
      assignedAt: dateValue(row.assigned_at)
    };
  }

  async listRoleAssignments() {
    const result = await this.query(
      "SELECT user_id, assigned_role, active, assigned_by, assigned_at FROM role_assignments WHERE organization_id = $1 ORDER BY user_id",
      [this.organizationId]
    );
    return asRows(result).map(row => this.serializeRoleAssignment(row));
  }

  async getRoleAssignment(userId) {
    const result = await this.query(
      "SELECT user_id, assigned_role, active, assigned_by, assigned_at FROM role_assignments WHERE organization_id = $1 AND user_id = $2",
      [this.organizationId, requiredText(userId, "user id")]
    );
    const row = asRows(result)[0];
    return row ? this.serializeRoleAssignment(row) : null;
  }

  serializeIntakeDraft(row) {
    const collaborators = Array.isArray(row.collaborators) ? row.collaborators : [];
    const explicitIds = new Set(collaborators.map(collaborator => collaborator.userId));
    const legacyIds = Array.isArray(row.collaborator_ids) ? row.collaborator_ids : [];
    const allCollaborators = [
      ...collaborators,
      ...legacyIds.filter(userId => !explicitIds.has(userId)).map(userId => ({ userId, permission: "edit", addedAt: dateValue(row.created_at), addedBy: row.created_by }))
    ];
    return {
      id: row.id, status: row.status, ownerId: row.owner_id,
      collaborators: allCollaborators,
      collaboratorIds: allCollaborators.map(collaborator => collaborator.userId),
      content: row.content && typeof row.content === "object" ? row.content : {},
      createdAt: dateValue(row.created_at), createdBy: row.created_by,
      updatedAt: dateValue(row.updated_at), updatedBy: row.updated_by
    };
  }

  async getIntakeDraft(id) {
    const result = await this.query(
      `SELECT d.*,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('userId', c.collaborator_id, 'permission', c.permission, 'addedAt', c.added_at, 'addedBy', c.added_by) ORDER BY c.added_at, c.collaborator_id)
          FROM intake_draft_collaborators c
          WHERE c.organization_id = d.organization_id AND c.draft_id = d.id
        ), '[]'::jsonb) AS collaborators
       FROM intake_drafts d WHERE d.organization_id = $1 AND d.id = $2`,
      [this.organizationId, requiredText(id, "draft id")]
    );
    const row = asRows(result)[0];
    if (!row) throw new WorkflowError("NOT_FOUND", "Intake draft not found.", 404);
    return this.serializeIntakeDraft(row);
  }

  async listIntakeDrafts(actorId) {
    const result = await this.query(
      `SELECT d.*,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('userId', c.collaborator_id, 'permission', c.permission, 'addedAt', c.added_at, 'addedBy', c.added_by) ORDER BY c.added_at, c.collaborator_id)
          FROM intake_draft_collaborators c
          WHERE c.organization_id = d.organization_id AND c.draft_id = d.id
        ), '[]'::jsonb) AS collaborators
       FROM intake_drafts d
       WHERE d.organization_id = $1 AND (
        d.owner_id = $2 OR d.collaborator_ids ? $2 OR EXISTS (
          SELECT 1 FROM intake_draft_collaborators c WHERE c.organization_id = d.organization_id AND c.draft_id = d.id AND c.collaborator_id = $2
        )
       )
       ORDER BY d.updated_at DESC`,
      [this.organizationId, requiredText(actorId, "actor id")]
    );
    return asRows(result).map(row => this.serializeIntakeDraft(row));
  }

  async listProjects({ projectId, includeDeleted = false } = {}) {
    const projectFilter = projectId ? " AND p.id = $2" : "";
    const projectValues = projectId ? [this.organizationId, projectId] : [this.organizationId];
    const projectResult = await this.query(
      `SELECT p.id, p.title, p.stage, p.origin_team, p.target_users, p.potential_reach, p.problem,
        p.metric, p.baseline, p.target, p.metric_source, p.metric_owner_id, p.sponsor_id,
        p.cycle_id, p.receiving_owner_id, p.project_lead_id, p.risk_classification, p.capacity_units, p.transfer_date,
        p.adoption_acknowledged_at, p.triage_status, p.information_requested_by, p.information_requested_at,
        p.shared_platform_impact, p.extension_count, p.created_at, p.created_by,
        p.updated_at, p.updated_by, p.deleted_at, p.deleted_by, p.deletion_reason
       FROM projects p
       WHERE p.organization_id = $1${includeDeleted ? "" : " AND p.deleted_at IS NULL"}${projectFilter}
       ORDER BY p.updated_at DESC`,
      projectValues
    );
    const rows = asRows(projectResult);
    if (!rows.length) return [];
    const projectIds = rows.map(row => row.id);
    const [gatesResult, evidenceResult, reviewsResult, deliveryKitResult, workItemsResult, calendarEventsResult, followUpsResult, decisionsResult, approvalsResult, handoffsResult] = await Promise.all([
      this.query("SELECT project_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason, artifact_verification_status, artifact_verified_at, artifact_verification_method FROM project_gates WHERE organization_id = $1 AND project_id = ANY($2::text[]) ORDER BY gate_key", [this.organizationId, projectIds]),
      this.query("SELECT id, project_id, evidence_type, result, sample_size, confidence, source_link, observed_at, created_by, created_at, artifact_verification_status, artifact_verified_at, artifact_verification_method FROM evidence_entries WHERE organization_id = $1 AND project_id = ANY($2::text[]) ORDER BY observed_at DESC, created_at DESC", [this.organizationId, projectIds]),
      this.query("SELECT project_id, review_type, status, evidence_link, completed_by, completed_at, exception_reason, artifact_verification_status, artifact_verified_at, artifact_verification_method FROM project_reviews WHERE organization_id = $1 AND project_id = ANY($2::text[]) ORDER BY review_type", [this.organizationId, projectIds]),
      this.query("SELECT project_id, item_key, status, owner_id, evidence_link, accepted_at, accepted_by, updated_at, updated_by, artifact_verification_status, artifact_verified_at, artifact_verification_method FROM delivery_kit_items WHERE organization_id = $1 AND project_id = ANY($2::text[]) ORDER BY item_key", [this.organizationId, projectIds]),
      this.query("SELECT project_id, provider, external_ref, external_url, external_status, last_verified_at, linked_by, linked_at, updated_by, updated_at FROM project_work_items WHERE organization_id = $1 AND project_id = ANY($2::text[])", [this.organizationId, projectIds]),
      this.query("SELECT project_id, event_key, event_type, decision_id, provider, external_ref, external_url, scheduled_for, last_verified_at, created_by, created_at, updated_by, updated_at FROM project_calendar_events WHERE organization_id = $1 AND project_id = ANY($2::text[]) ORDER BY scheduled_for, event_key", [this.organizationId, projectIds]),
      this.query("SELECT project_id, due_on, status, reminder_notification_id, created_at, created_by, completed_at, completed_by FROM project_follow_ups WHERE organization_id = $1 AND project_id = ANY($2::text[])", [this.organizationId, projectIds]),
      this.query("SELECT id, project_id, outcome, rationale, status, requested_by, requested_at, finalized_by, finalized_at FROM decisions WHERE organization_id = $1 AND project_id = ANY($2::text[]) ORDER BY requested_at DESC", [this.organizationId, projectIds]),
      this.query("SELECT a.decision_id, a.approver_id, a.approver_role, a.result, a.comment, a.created_at FROM approvals a JOIN decisions d ON d.id = a.decision_id AND d.organization_id = a.organization_id WHERE a.organization_id = $1 AND d.project_id = ANY($2::text[]) ORDER BY a.created_at", [this.organizationId, projectIds]),
      this.query("SELECT project_id, receiving_owner_id, status, adoption_plan_link, support_end_date, follow_up_date, onboarding_acknowledged, accepted_by, accepted_at, artifact_verification_status, artifact_verified_at, artifact_verification_method FROM handoffs WHERE organization_id = $1 AND project_id = ANY($2::text[])", [this.organizationId, projectIds])
    ]);

    const gates = new Map();
    for (const row of asRows(gatesResult)) appendByProject(gates, row.project_id, {
      key: row.gate_key, status: row.status, evidenceLink: row.evidence_link, completedBy: row.completed_by,
      completedAt: dateValue(row.completed_at), exceptionReason: row.exception_reason,
      artifactVerificationStatus: row.artifact_verification_status || null,
      artifactVerifiedAt: dateValue(row.artifact_verified_at),
      artifactVerificationMethod: row.artifact_verification_method || null
    });
    const evidence = new Map();
    for (const row of asRows(evidenceResult)) appendByProject(evidence, row.project_id, {
      id: row.id, evidenceType: row.evidence_type, result: row.result, sampleSize: row.sample_size, confidence: row.confidence,
      sourceLink: row.source_link, observedAt: dateValue(row.observed_at), createdBy: row.created_by, createdAt: dateValue(row.created_at),
      artifactVerificationStatus: row.artifact_verification_status || null,
      artifactVerifiedAt: dateValue(row.artifact_verified_at),
      artifactVerificationMethod: row.artifact_verification_method || null
    });
    const reviews = new Map();
    for (const row of asRows(reviewsResult)) appendByProject(reviews, row.project_id, {
      reviewType: row.review_type, status: row.status, evidenceLink: row.evidence_link, completedBy: row.completed_by,
      completedAt: dateValue(row.completed_at), exceptionReason: row.exception_reason,
      artifactVerificationStatus: row.artifact_verification_status || null,
      artifactVerifiedAt: dateValue(row.artifact_verified_at),
      artifactVerificationMethod: row.artifact_verification_method || null
    });
    const deliveryKit = new Map();
    for (const row of asRows(deliveryKitResult)) appendByProject(deliveryKit, row.project_id, {
      projectId: row.project_id, itemKey: row.item_key, status: row.status, ownerId: row.owner_id, evidenceLink: row.evidence_link,
      acceptedAt: dateValue(row.accepted_at), acceptedBy: row.accepted_by, updatedAt: dateValue(row.updated_at), updatedBy: row.updated_by,
      artifactVerificationStatus: row.artifact_verification_status || null,
      artifactVerifiedAt: dateValue(row.artifact_verified_at),
      artifactVerificationMethod: row.artifact_verification_method || null
    });
    const workItems = new Map();
    for (const row of asRows(workItemsResult)) workItems.set(row.project_id, {
      projectId: row.project_id, provider: row.provider, externalRef: row.external_ref, externalUrl: row.external_url,
      externalStatus: row.external_status, lastVerifiedAt: dateValue(row.last_verified_at),
      linkedBy: row.linked_by, linkedAt: dateValue(row.linked_at), updatedBy: row.updated_by, updatedAt: dateValue(row.updated_at)
    });
    const calendarEvents = new Map();
    for (const row of asRows(calendarEventsResult)) appendByProject(calendarEvents, row.project_id, {
      projectId: row.project_id, eventKey: row.event_key, eventType: row.event_type, decisionId: row.decision_id,
      provider: row.provider, externalRef: row.external_ref, externalUrl: row.external_url, scheduledFor: dateValue(row.scheduled_for),
      lastVerifiedAt: dateValue(row.last_verified_at), createdBy: row.created_by, createdAt: dateValue(row.created_at),
      updatedBy: row.updated_by, updatedAt: dateValue(row.updated_at)
    });
    const followUps = new Map();
    for (const row of asRows(followUpsResult)) {
      const followUp = {
        projectId: row.project_id,
        dueOn: dateValue(row.due_on),
        status: row.status,
        reminderNotificationId: row.reminder_notification_id,
        createdAt: dateValue(row.created_at),
        createdBy: row.created_by,
        completedAt: dateValue(row.completed_at),
        completedBy: row.completed_by
      };
      followUps.set(row.project_id, { ...followUp, derivedStatus: followUpStatus(followUp) });
    }
    const decisions = new Map();
    for (const row of asRows(decisionsResult)) appendByProject(decisions, row.project_id, {
      id: row.id, projectId: row.project_id, outcome: row.outcome, rationale: row.rationale, status: row.status,
      requestedBy: row.requested_by, requestedAt: dateValue(row.requested_at), finalizedBy: row.finalized_by, finalizedAt: dateValue(row.finalized_at)
    });
    const approvals = new Map();
    for (const row of asRows(approvalsResult)) {
      const values = approvals.get(row.decision_id) || [];
      values.push({ approverId: row.approver_id, approverRole: row.approver_role, result: row.result, comment: row.comment, createdAt: dateValue(row.created_at) });
      approvals.set(row.decision_id, values);
    }
    const handoffs = new Map();
    for (const row of asRows(handoffsResult)) handoffs.set(row.project_id, {
      projectId: row.project_id, receivingOwnerId: row.receiving_owner_id, status: row.status, adoptionPlanLink: row.adoption_plan_link,
      supportEndDate: dateValue(row.support_end_date), followUpDate: dateValue(row.follow_up_date), onboardingAcknowledged: Boolean(row.onboarding_acknowledged),
      acceptedBy: row.accepted_by, acceptedAt: dateValue(row.accepted_at),
      artifactVerificationStatus: row.artifact_verification_status || null,
      artifactVerifiedAt: dateValue(row.artifact_verified_at),
      artifactVerificationMethod: row.artifact_verification_method || null
    });

    return rows.map(row => {
      const projectGates = gates.get(row.id) || [];
      const projectReviews = reviews.get(row.id) || [];
      const projectDecisions = decisions.get(row.id) || [];
      const pending = projectDecisions.find(decision => decision.status === "requested");
      const reviewRequirements = requiredReviewTypes(row.risk_classification);
      const projectDeliveryKit = defaultDeliveryKitItems(row.id, deliveryKit.get(row.id) || []);
      return {
        id: row.id, title: row.title, stage: row.stage, originTeam: row.origin_team, users: row.target_users,
        potentialReach: row.potential_reach, problem: row.problem, metric: row.metric, baseline: row.baseline,
        target: row.target, metricSource: row.metric_source, metricOwnerId: row.metric_owner_id,
        sponsor: { id: row.sponsor_id }, receivingOwner: row.receiving_owner_id ? { id: row.receiving_owner_id } : null,
        projectLead: { id: row.project_lead_id }, riskClassification: row.risk_classification, transferDate: dateValue(row.transfer_date),
        adoptionAcknowledged: Boolean(row.adoption_acknowledged_at), adoptionAcknowledgedAt: dateValue(row.adoption_acknowledged_at),
        cycleId: row.cycle_id, capacityUnits: row.capacity_units || 1,
        triageStatus: row.triage_status || "open", informationRequestedBy: row.information_requested_by, informationRequestedAt: dateValue(row.information_requested_at),
        sharedPlatformImpact: Boolean(row.shared_platform_impact), extensionCount: row.extension_count, gates: projectGates,
        evidence: evidence.get(row.id) || [], reviews: projectReviews, reviewRequirements,
        reviewsComplete: reviewRequirements.every(type => projectReviews.some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status))),
        deliveryKit: projectDeliveryKit,
        workItem: workItems.get(row.id) || null,
        calendarEvents: calendarEvents.get(row.id) || [],
        followUp: followUps.get(row.id) || null,
        decisionHistory: projectDecisions.slice(0, 5),
        pendingDecision: pending ? {
          ...pending, approvals: approvals.get(pending.id) || [],
          requiredApprovers: requiredApproverRoles(pending.outcome, { sharedPlatformImpact: Boolean(row.shared_platform_impact) }),
          missingGates: missingGates(pending.outcome, projectGates, { deliveryKit: projectDeliveryKit })
        } : null,
        handoff: handoffs.get(row.id) || null, createdAt: dateValue(row.created_at), createdBy: row.created_by,
        updatedAt: dateValue(row.updated_at), updatedBy: row.updated_by,
        deletedAt: dateValue(row.deleted_at), deletedBy: row.deleted_by, deletionReason: row.deletion_reason
      };
    });
  }

  async listAuditEvents(limit = 100) {
    const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 100;
    const result = await this.query(
      "SELECT id, actor_id, action, entity_type, entity_id, before_summary, after_summary, created_at FROM audit_events WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2",
      [this.organizationId, boundedLimit]
    );
    return asRows(result).map(row => ({
      id: row.id, actorId: row.actor_id, action: row.action, entityType: row.entity_type, entityId: row.entity_id,
      before: row.before_summary, after: row.after_summary, createdAt: dateValue(row.created_at)
    }));
  }

  async listTriageComments(projectId) {
    const result = await this.query(
      `SELECT id, project_id AS "projectId", author_id AS "authorId", comment_kind AS kind, comment_text AS comment, created_at AS "createdAt"
       FROM project_triage_comments
       WHERE organization_id = $1 AND project_id = $2
       ORDER BY created_at, comment_sequence`,
      [this.organizationId, requiredText(projectId, "project id")]
    );
    return asRows(result).map(row => ({ ...row, createdAt: dateValue(row.createdAt) }));
  }

  serializeIntakeRevision(row) {
    return {
      id: row.id,
      projectId: row.projectId,
      revisionNumber: row.revisionNumber,
      content: row.content && typeof row.content === "object" ? row.content : {},
      submittedBy: row.submittedBy,
      submittedAt: dateValue(row.submittedAt)
    };
  }

  async listIntakeRevisions(projectId) {
    const result = await this.query(
      `SELECT id, project_id AS "projectId", revision_number AS "revisionNumber", content,
        submitted_by AS "submittedBy", submitted_at AS "submittedAt"
       FROM intake_revisions
       WHERE organization_id = $1 AND project_id = $2
       ORDER BY revision_number`,
      [this.organizationId, requiredText(projectId, "project id")]
    );
    return asRows(result).map(row => this.serializeIntakeRevision(row));
  }

  async getIntakeRevision(projectId, revisionNumber) {
    const result = await this.query(
      `SELECT id, project_id AS "projectId", revision_number AS "revisionNumber", content,
        submitted_by AS "submittedBy", submitted_at AS "submittedAt"
       FROM intake_revisions
       WHERE organization_id = $1 AND project_id = $2 AND revision_number = $3`,
      [this.organizationId, requiredText(projectId, "project id"), revisionNumber]
    );
    const row = asRows(result)[0];
    return row ? this.serializeIntakeRevision(row) : null;
  }

  async health() {
    try {
      const result = await this.queryable.query("SELECT 1 AS ok", []);
      return asRows(result)[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close() {
    if (typeof this.queryable.end === "function") await this.queryable.end();
  }
}

export function createPostgresReadAdapter({ databaseUrl, organizationId, PoolConstructor = Pool } = {}) {
  const connectionString = requiredText(databaseUrl, "databaseUrl");
  return new PostgresReadAdapter({ queryable: new PoolConstructor({ connectionString }), organizationId });
}
