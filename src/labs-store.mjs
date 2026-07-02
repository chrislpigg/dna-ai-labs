import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  WorkflowError,
  finalStage,
  missingGates,
  outcomes,
  requireRole,
  requireTransition,
  requiredApproverRoles,
  requiredReviewTypes,
  roles,
  reviewTypes,
  stages
} from "./workflow-policy.mjs";
import { WorkflowService } from "./workflow-service.mjs";
import { retentionClassification, retentionUntil } from "./retention-policy.mjs";
import { auditEventHash, auditGenesisHash, verifyAuditChain } from "./audit-integrity.mjs";

const now = () => new Date().toISOString();
const json = value => JSON.stringify(value ?? {});
const parse = value => value ? JSON.parse(value) : {};

const seedUsers = [
  ["employee-1", "Employee", roles.EMPLOYEE],
  ["submitter-1", "Taylor Submitter", roles.SUBMITTER],
  ["accessibility-lead", "Avery Accessibility", roles.PROJECT_LEAD],
  ["ube-lead", "Uma UBE", roles.PROJECT_LEAD],
  ["lab-lead", "Morgan Lab Lead", roles.LAB_LEAD],
  ["executive-sponsor", "Jordan Executive Sponsor", roles.EXECUTIVE_SPONSOR],
  ["platform-reviewer", "Parker Platform", roles.PLATFORM_REVIEWER],
  ["receiving-owner", "Riley Receiving Owner", roles.RECEIVING_OWNER],
  ["admin", "Program Administrator", roles.ADMIN]
];

const seedProjects = [
  {
    id: "accessibility-agent", title: "Accessibility agent", stage: stages.TRIAGE, originTeam: "Experience Engineering", users: "Engineering teams and accessibility reviewers", potentialReach: 7,
    problem: "Accessibility feedback arrives late and is difficult to turn into clear, prioritized engineering work.", metric: "Accessibility-review cycle time", baseline: "Capture before pilot", target: "Reduce review cycle time", metricSource: "TBD", metricOwner: "accessibility-lead", sponsorId: "executive-sponsor", receivingOwnerId: "receiving-owner", riskClassification: "Internal", transferDate: "2026-09-18", projectLeadId: "accessibility-lead", sharedPlatformImpact: true
  },
  {
    id: "ube-agent", title: "UBE agent", stage: stages.TRIAGE, originTeam: "Quality Engineering", users: "Teams running the UBE workflow", potentialReach: 4,
    problem: "Teams need a consistent, low-friction way to complete the UBE workflow without relying on its original builders.", metric: "Workflow completion time and quality", baseline: "Capture before pilot", target: "Define with receiving team", metricSource: "TBD", metricOwner: "ube-lead", sponsorId: "executive-sponsor", receivingOwnerId: null, riskClassification: "Internal", transferDate: "2026-09-18", projectLeadId: "ube-lead", sharedPlatformImpact: false
  }
];

/** SQLite persistence adapter. Demo and tests only; workflow rules live in WorkflowService. */
export class SqliteLabsStorage {
  constructor(file, { approvedArtifactOrigins = ["https://intranet.example"] } = {}) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.approvedArtifactOrigins = new Set(approvedArtifactOrigins);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
    this.seed();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS cycles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, title TEXT NOT NULL, stage TEXT NOT NULL, origin_team TEXT NOT NULL,
        target_users TEXT NOT NULL, potential_reach INTEGER NOT NULL, problem TEXT NOT NULL, metric TEXT NOT NULL,
        baseline TEXT NOT NULL, target TEXT NOT NULL, metric_source TEXT NOT NULL, metric_owner_id TEXT NOT NULL,
        sponsor_id TEXT NOT NULL, receiving_owner_id TEXT, project_lead_id TEXT NOT NULL, risk_classification TEXT NOT NULL,
        transfer_date TEXT, adoption_acknowledged_by TEXT, adoption_acknowledged_at TEXT, shared_platform_impact INTEGER NOT NULL DEFAULT 0, extension_count INTEGER NOT NULL DEFAULT 0,
        triage_status TEXT NOT NULL DEFAULT 'open', information_requested_by TEXT, information_requested_at TEXT,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        deleted_at TEXT, deleted_by TEXT, deletion_reason TEXT,
        FOREIGN KEY(sponsor_id) REFERENCES users(id), FOREIGN KEY(receiving_owner_id) REFERENCES users(id), FOREIGN KEY(project_lead_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS intake_drafts (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Draft', owner_id TEXT NOT NULL,
        collaborator_ids_json TEXT NOT NULL DEFAULT '[]', content_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
        FOREIGN KEY(owner_id) REFERENCES users(id), FOREIGN KEY(created_by) REFERENCES users(id), FOREIGN KEY(updated_by) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS intake_draft_collaborators (
        draft_id TEXT NOT NULL, collaborator_id TEXT NOT NULL, permission TEXT NOT NULL DEFAULT 'edit',
        added_at TEXT NOT NULL, added_by TEXT NOT NULL,
        PRIMARY KEY(draft_id, collaborator_id),
        FOREIGN KEY(draft_id) REFERENCES intake_drafts(id) ON DELETE CASCADE,
        FOREIGN KEY(collaborator_id) REFERENCES users(id), FOREIGN KEY(added_by) REFERENCES users(id),
        CHECK(permission = 'edit')
      );
      CREATE INDEX IF NOT EXISTS intake_drafts_owner_updated_idx ON intake_drafts (owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS intake_draft_collaborators_user_idx ON intake_draft_collaborators (collaborator_id, draft_id);
      CREATE TABLE IF NOT EXISTS project_triage_comments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, author_id TEXT NOT NULL, comment_kind TEXT NOT NULL DEFAULT 'comment',
        comment_text TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY(author_id) REFERENCES users(id),
        CHECK(comment_kind IN ('comment', 'request_for_information'))
      );
      CREATE INDEX IF NOT EXISTS project_triage_comments_project_created_idx ON project_triage_comments (project_id, created_at, id);
      CREATE TABLE IF NOT EXISTS project_gates (
        project_id TEXT NOT NULL, gate_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'incomplete', evidence_link TEXT,
        completed_by TEXT, completed_at TEXT, exception_reason TEXT,
        PRIMARY KEY(project_id, gate_key), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS evidence_entries (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, evidence_type TEXT NOT NULL, result TEXT NOT NULL,
        sample_size INTEGER NOT NULL, confidence TEXT NOT NULL, source_link TEXT NOT NULL, observed_at TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY(created_by) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS project_reviews (
        project_id TEXT NOT NULL, review_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'incomplete',
        evidence_link TEXT, completed_by TEXT, completed_at TEXT, exception_reason TEXT,
        PRIMARY KEY(project_id, review_type), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, outcome TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL,
        requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, finalized_by TEXT, finalized_at TEXT, retention_classification TEXT, retention_until TEXT, FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, approver_id TEXT NOT NULL, approver_role TEXT NOT NULL,
        result TEXT NOT NULL, comment TEXT, created_at TEXT NOT NULL, UNIQUE(decision_id, approver_role), FOREIGN KEY(decision_id) REFERENCES decisions(id)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        project_id TEXT PRIMARY KEY, receiving_owner_id TEXT NOT NULL, status TEXT NOT NULL,
        adoption_plan_link TEXT NOT NULL, support_end_date TEXT NOT NULL, follow_up_date TEXT NOT NULL,
        onboarding_acknowledged INTEGER NOT NULL DEFAULT 0, accepted_by TEXT, accepted_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE, FOREIGN KEY(receiving_owner_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        before_json TEXT, after_json TEXT, created_at TEXT NOT NULL, retention_classification TEXT NOT NULL DEFAULT 'program_record', retention_until TEXT NOT NULL,
        audit_sequence INTEGER, previous_hash TEXT, event_hash TEXT
      );
    `);
    this.ensureColumn("projects", "adoption_acknowledged_by", "TEXT");
    this.ensureColumn("projects", "adoption_acknowledged_at", "TEXT");
    this.ensureColumn("projects", "triage_status", "TEXT NOT NULL DEFAULT 'open'");
    this.ensureColumn("projects", "information_requested_by", "TEXT");
    this.ensureColumn("projects", "information_requested_at", "TEXT");
    this.ensureColumn("projects", "deleted_at", "TEXT");
    this.ensureColumn("projects", "deleted_by", "TEXT");
    this.ensureColumn("projects", "deletion_reason", "TEXT");
    this.ensureColumn("decisions", "retention_classification", "TEXT");
    this.ensureColumn("decisions", "retention_until", "TEXT");
    this.ensureColumn("audit_events", "retention_classification", "TEXT");
    this.ensureColumn("audit_events", "retention_until", "TEXT");
    this.ensureColumn("audit_events", "audit_sequence", "INTEGER");
    this.ensureColumn("audit_events", "previous_hash", "TEXT");
    this.ensureColumn("audit_events", "event_hash", "TEXT");
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  seed() {
    const insertUser = this.db.prepare("INSERT OR IGNORE INTO users (id, name, role) VALUES (?, ?, ?)");
    for (const user of seedUsers) insertUser.run(...user);
    this.db.prepare("INSERT OR IGNORE INTO cycles (id, name, theme, starts_on, ends_on, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run("cycle-2026-q3", "Cycle 01 · 2026", "Engineering quality and inclusion", "2026-07-01", "2026-09-30", "planned");
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count;
    if (existing) return;
    const insertProject = this.db.prepare(`INSERT INTO projects (
      id, cycle_id, title, stage, origin_team, target_users, potential_reach, problem, metric, baseline, target, metric_source, metric_owner_id,
      sponsor_id, receiving_owner_id, project_lead_id, risk_classification, transfer_date, shared_platform_impact, created_at, created_by, updated_at, updated_by
    ) VALUES (?, 'cycle-2026-q3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, 'admin')`);
    for (const project of seedProjects) {
      const timestamp = now();
      insertProject.run(project.id, project.title, project.stage, project.originTeam, project.users, project.potentialReach, project.problem, project.metric, project.baseline, project.target, project.metricSource, project.metricOwner, project.sponsorId, project.receivingOwnerId, project.projectLeadId, project.riskClassification, project.transferDate, project.sharedPlatformImpact ? 1 : 0, timestamp, timestamp);
      this.audit("admin", "seeded", "project", project.id, null, { stage: project.stage });
    }
  }

  actor(id) {
    const actor = this.db.prepare("SELECT id, name, role FROM users WHERE id = ? AND active = 1").get(id);
    if (!actor) throw new WorkflowError("UNAUTHENTICATED", "A valid authenticated user is required.", 401);
    return actor;
  }

  users() {
    return this.db.prepare("SELECT id, role FROM users WHERE active = 1 ORDER BY id").all();
  }

  audit(actorId, action, entityType, entityId, before, after) {
    const timestamp = now();
    const last = this.db.prepare("SELECT audit_sequence, event_hash FROM audit_events ORDER BY audit_sequence DESC LIMIT 1").get();
    const auditSequence = Number(last?.audit_sequence || 0) + 1;
    const previousHash = last?.event_hash || auditGenesisHash;
    const eventHash = auditEventHash({ auditSequence, previousHash, actorId, action, entityType, entityId, before: before || null, after: after || null, createdAt: timestamp });
    this.db.prepare("INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, before_json, after_json, created_at, retention_classification, retention_until, audit_sequence, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), actorId, action, entityType, entityId, before ? json(before) : null, after ? json(after) : null, timestamp, retentionClassification, retentionUntil(timestamp), auditSequence, previousHash, eventHash);
  }

  project(id) {
    const row = this.db.prepare(`SELECT p.*, sponsor.name AS sponsor_name, receiver.name AS receiving_owner_name, lead.name AS project_lead_name
      FROM projects p JOIN users sponsor ON sponsor.id = p.sponsor_id LEFT JOIN users receiver ON receiver.id = p.receiving_owner_id
      JOIN users lead ON lead.id = p.project_lead_id WHERE p.id = ? AND p.deleted_at IS NULL`).get(id);
    if (!row) throw new WorkflowError("NOT_FOUND", "Project not found.", 404);
    return this.serializeProject(row);
  }

  listProjects() {
    const rows = this.db.prepare(`SELECT p.*, sponsor.name AS sponsor_name, receiver.name AS receiving_owner_name, lead.name AS project_lead_name
      FROM projects p JOIN users sponsor ON sponsor.id = p.sponsor_id LEFT JOIN users receiver ON receiver.id = p.receiving_owner_id
      JOIN users lead ON lead.id = p.project_lead_id WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC`).all();
    return rows.map(row => this.serializeProject(row));
  }

  serializeIntakeDraft(row) {
    const explicit = this.db.prepare("SELECT collaborator_id AS userId, permission, added_at AS addedAt, added_by AS addedBy FROM intake_draft_collaborators WHERE draft_id = ? ORDER BY added_at, collaborator_id").all(row.id);
    const existing = new Set(explicit.map(collaborator => collaborator.userId));
    const legacy = Array.isArray(parse(row.collaborator_ids_json)) ? parse(row.collaborator_ids_json) : [];
    const collaborators = [
      ...explicit,
      ...legacy.filter(userId => !existing.has(userId)).map(userId => ({ userId, permission: "edit", addedAt: row.created_at, addedBy: row.created_by }))
    ];
    return {
      id: row.id, status: row.status, ownerId: row.owner_id,
      collaborators,
      collaboratorIds: collaborators.map(collaborator => collaborator.userId),
      content: parse(row.content_json),
      createdAt: row.created_at, createdBy: row.created_by, updatedAt: row.updated_at, updatedBy: row.updated_by
    };
  }

  getIntakeDraft(id) {
    const row = this.db.prepare("SELECT * FROM intake_drafts WHERE id = ?").get(id);
    if (!row) throw new WorkflowError("NOT_FOUND", "Intake draft not found.", 404);
    return this.serializeIntakeDraft(row);
  }

  listIntakeDrafts(actorId) {
    return this.db.prepare(`SELECT * FROM intake_drafts
      WHERE owner_id = ? OR EXISTS (
        SELECT 1 FROM intake_draft_collaborators WHERE intake_draft_collaborators.draft_id = intake_drafts.id AND intake_draft_collaborators.collaborator_id = ?
      ) OR EXISTS (
        SELECT 1 FROM json_each(intake_drafts.collaborator_ids_json) WHERE json_each.value = ?
      )
      ORDER BY updated_at DESC`).all(actorId, actorId, actorId).map(row => this.serializeIntakeDraft(row));
  }

  serializeProject(row) {
    const gates = this.db.prepare("SELECT gate_key AS key, status, evidence_link AS evidenceLink, completed_by AS completedBy, completed_at AS completedAt, exception_reason AS exceptionReason FROM project_gates WHERE project_id = ? ORDER BY gate_key").all(row.id);
    const evidence = this.db.prepare("SELECT id, evidence_type AS evidenceType, result, sample_size AS sampleSize, confidence, source_link AS sourceLink, observed_at AS observedAt, created_by AS createdBy, created_at AS createdAt FROM evidence_entries WHERE project_id = ? ORDER BY observed_at DESC, created_at DESC").all(row.id);
    const decisionHistory = this.db.prepare("SELECT id, outcome, rationale, status, requested_at AS requestedAt, finalized_at AS finalizedAt FROM decisions WHERE project_id = ? ORDER BY requested_at DESC LIMIT 5").all(row.id);
    const reviewRequirements = requiredReviewTypes(row.risk_classification);
    const reviews = this.db.prepare("SELECT review_type AS reviewType, status, evidence_link AS evidenceLink, completed_by AS completedBy, completed_at AS completedAt, exception_reason AS exceptionReason FROM project_reviews WHERE project_id = ? ORDER BY review_type").all(row.id);
    const reviewsComplete = reviewRequirements.every(type => reviews.some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status)));
    const decision = this.db.prepare("SELECT id, outcome, rationale, status, requested_by AS requestedBy, requested_at AS requestedAt FROM decisions WHERE project_id = ? AND status = 'requested' ORDER BY requested_at DESC LIMIT 1").get(row.id);
    const decisionApprovals = decision ? this.db.prepare("SELECT approver_id AS approverId, approver_role AS approverRole, result, comment, created_at AS createdAt FROM approvals WHERE decision_id = ? ORDER BY created_at").all(decision.id) : [];
    const pendingDecision = decision ? { ...decision, approvals: decisionApprovals, requiredApprovers: requiredApproverRoles(decision.outcome, { sharedPlatformImpact: Boolean(row.shared_platform_impact) }), missingGates: missingGates(decision.outcome, gates) } : null;
    const handoff = this.db.prepare("SELECT project_id AS projectId, receiving_owner_id AS receivingOwnerId, status, adoption_plan_link AS adoptionPlanLink, support_end_date AS supportEndDate, follow_up_date AS followUpDate, onboarding_acknowledged AS onboardingAcknowledged, accepted_by AS acceptedBy, accepted_at AS acceptedAt FROM handoffs WHERE project_id = ?").get(row.id) || null;
    return {
      id: row.id, title: row.title, stage: row.stage, originTeam: row.origin_team, users: row.target_users, potentialReach: row.potential_reach,
      problem: row.problem, metric: row.metric, baseline: row.baseline, target: row.target, metricSource: row.metric_source, metricOwnerId: row.metric_owner_id,
      sponsor: { id: row.sponsor_id, name: row.sponsor_name }, receivingOwner: row.receiving_owner_id ? { id: row.receiving_owner_id, name: row.receiving_owner_name } : null,
      projectLead: { id: row.project_lead_id, name: row.project_lead_name }, riskClassification: row.risk_classification, transferDate: row.transfer_date,
      adoptionAcknowledged: Boolean(row.adoption_acknowledged_at), adoptionAcknowledgedAt: row.adoption_acknowledged_at,
      triageStatus: row.triage_status || "open", informationRequestedBy: row.information_requested_by, informationRequestedAt: row.information_requested_at,
      sharedPlatformImpact: Boolean(row.shared_platform_impact), extensionCount: row.extension_count, gates, evidence, reviews, reviewRequirements, reviewsComplete, decisionHistory, pendingDecision, handoff: handoff ? { ...handoff, onboardingAcknowledged: Boolean(handoff.onboardingAcknowledged) } : null,
      createdAt: row.created_at, createdBy: row.created_by, updatedAt: row.updated_at, updatedBy: row.updated_by,
      deletedAt: row.deleted_at, deletedBy: row.deleted_by, deletionReason: row.deletion_reason
    };
  }

  validateIntake(input) {
    const required = ["title", "originTeam", "users", "problem", "metric", "baseline", "target", "metricSource", "metricOwnerId", "sponsorId", "projectLeadId", "riskClassification"];
    const missing = required.filter(key => !String(input[key] ?? "").trim());
    if (missing.length) throw new WorkflowError("INVALID_INTAKE", "Required intake information is missing.", 422, { missing });
    if (!Number.isInteger(Number(input.potentialReach)) || Number(input.potentialReach) < 1) throw new WorkflowError("INVALID_REACH", "Potential company reach must be at least one team.", 422);
    if (input.transferDate && new Date(`${input.transferDate}T12:00:00`) <= new Date()) throw new WorkflowError("INVALID_TRANSFER_DATE", "Transfer target must be in the future.", 422);
    this.actor(input.sponsorId); this.actor(input.projectLeadId); this.actor(input.metricOwnerId);
    if (input.receivingOwnerId) this.actor(input.receivingOwnerId);
    if (!input.adoptionGate || !input.evidenceGate) throw new WorkflowError("GATES_UNCONFIRMED", "Adoption and evidence gates must be confirmed before submission.", 422);
  }

  createIntake(actor, input) {
    requireRole(actor, [roles.SUBMITTER, roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    this.validateIntake(input);
    const id = randomUUID(); const timestamp = now();
    this.db.prepare(`INSERT INTO projects (
      id, cycle_id, title, stage, origin_team, target_users, potential_reach, problem, metric, baseline, target, metric_source, metric_owner_id,
      sponsor_id, receiving_owner_id, project_lead_id, risk_classification, transfer_date, shared_platform_impact, created_at, created_by, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.cycleId || "cycle-2026-q3", input.title.trim(), stages.SUBMITTED, input.originTeam.trim(), input.users.trim(), Number(input.potentialReach), input.problem.trim(), input.metric.trim(), input.baseline.trim(), input.target.trim(), input.metricSource.trim(), input.metricOwnerId, input.sponsorId, input.receivingOwnerId || null, input.projectLeadId, input.riskClassification, input.transferDate || null, input.sharedPlatformImpact ? 1 : 0, timestamp, actor.id, timestamp, actor.id);
    this.audit(actor.id, "intake_submitted", "project", id, null, { stage: stages.SUBMITTED, title: input.title.trim() });
    return this.project(id);
  }

  selectProject(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(id);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged projects can be selected.", 409);
    if (!project.receivingOwner) throw new WorkflowError("MISSING_RECEIVING_OWNER", "Selection requires a named receiving owner.", 409);
    if (!project.adoptionAcknowledged) throw new WorkflowError("MISSING_ADOPTION_ACK", "Selection requires acknowledgement from the named receiving owner.", 409);
    const timestamp = now();
    this.db.prepare("UPDATE projects SET stage = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stages.SELECTED, timestamp, actor.id, id);
    this.audit(actor.id, "project_selected", "project", id, { stage: project.stage }, { stage: stages.SELECTED });
    return this.project(id);
  }

  acknowledgeAdoption(actor, projectId) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can acknowledge this adoption path.", 403);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Adoption acknowledgement must happen before selection.", 409);
    if (project.adoptionAcknowledged) throw new WorkflowError("ADOPTION_ALREADY_ACKNOWLEDGED", "This adoption path has already been acknowledged.", 409);
    const timestamp = now();
    this.db.prepare("UPDATE projects SET adoption_acknowledged_by = ?, adoption_acknowledged_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(actor.id, timestamp, timestamp, actor.id, projectId);
    this.audit(actor.id, "adoption_acknowledged", "project", projectId, { adoptionAcknowledged: false }, { adoptionAcknowledged: true });
    return this.project(projectId);
  }

  startIncubation(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(id);
    if (project.stage !== stages.SELECTED) throw new WorkflowError("INVALID_STATE", "Only selected projects can start incubation.", 409);
    this.db.prepare("UPDATE projects SET stage = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stages.INCUBATING, now(), actor.id, id);
    this.audit(actor.id, "incubation_started", "project", id, { stage: project.stage }, { stage: stages.INCUBATING });
    return this.project(id);
  }

  setGate(actor, projectId, key, input) {
    requireRole(actor, [roles.LAB_LEAD, roles.PLATFORM_REVIEWER, roles.ADMIN]);
    const project = this.project(projectId);
    if (!String(key).match(/^[a-z_]+$/)) throw new WorkflowError("INVALID_GATE", "Gate key is invalid.", 422);
    if (key === "receiving_owner_ack") throw new WorkflowError("HANDOFF_REQUIRED", "Only the named receiving owner can complete the handoff acknowledgement.", 409);
    if (key === "metric_evidence") throw new WorkflowError("EVIDENCE_ENTRY_REQUIRED", "Metric evidence is completed only by recording a structured metric result.", 409);
    if (key === "reviews_complete") throw new WorkflowError("REVIEW_RECORD_REQUIRED", "Review completion is calculated from required review records.", 409);
    if (!['complete', 'excepted', 'incomplete'].includes(input.status)) throw new WorkflowError("INVALID_GATE_STATUS", "Gate status is invalid.", 422);
    if (input.status === 'complete' && !String(input.evidenceLink ?? '').trim()) throw new WorkflowError("MISSING_EVIDENCE", "Completed gates require an approved evidence link.", 422);
    if (input.status === 'excepted' && !String(input.exceptionReason ?? '').trim()) throw new WorkflowError("MISSING_EXCEPTION", "Excepted gates require a written risk acceptance.", 422);
    if (input.status === 'complete') this.validateEvidenceLink(input.evidenceLink);
    const before = project.gates.find(gate => gate.key === key) || null;
    const timestamp = now();
    this.db.prepare(`INSERT INTO project_gates (project_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, gate_key) DO UPDATE SET status = excluded.status, evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = excluded.exception_reason`)
      .run(projectId, key, input.status, input.evidenceLink?.trim() || null, input.status === 'incomplete' ? null : actor.id, input.status === 'incomplete' ? null : timestamp, input.exceptionReason?.trim() || null);
    this.audit(actor.id, "gate_updated", "project_gate", `${projectId}:${key}`, before, { key, status: input.status });
    return this.project(projectId);
  }

  validateEvidenceLink(value) {
    let url;
    try { url = new URL(value); } catch { throw new WorkflowError("INVALID_EVIDENCE_LINK", "Evidence must be a valid approved URL.", 422); }
    if (!this.approvedArtifactOrigins.has(url.origin)) {
      throw new WorkflowError("UNAPPROVED_EVIDENCE_LINK", "Evidence must link to an approved internal system.", 422);
    }
  }

  addEvidence(actor, projectId, input) {
    requireRole(actor, [roles.PROJECT_LEAD, roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(projectId);
    if (actor.role === roles.PROJECT_LEAD && project.projectLead.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Project leads can record evidence only for their assigned projects.", 403);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Evidence can be recorded only during incubation or decision review.", 409);
    const allowedTypes = ["metric_result", "user_feedback", "pilot_demo"];
    if (!allowedTypes.includes(input.evidenceType)) throw new WorkflowError("INVALID_EVIDENCE_TYPE", "Evidence type is invalid.", 422);
    if (!String(input.result ?? "").trim()) throw new WorkflowError("MISSING_EVIDENCE_RESULT", "Evidence requires a result summary.", 422);
    if (!Number.isInteger(Number(input.sampleSize)) || Number(input.sampleSize) < 1) throw new WorkflowError("INVALID_SAMPLE_SIZE", "Evidence requires a sample size of at least one.", 422);
    if (!["low", "medium", "high"].includes(input.confidence)) throw new WorkflowError("INVALID_CONFIDENCE", "Evidence confidence is invalid.", 422);
    this.validateEvidenceLink(input.sourceLink);
    const observed = new Date(`${input.observedAt}T12:00:00`);
    if (!input.observedAt || Number.isNaN(observed.getTime()) || observed > new Date()) throw new WorkflowError("INVALID_OBSERVED_DATE", "Evidence date must be today or earlier.", 422);
    const id = randomUUID(); const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO evidence_entries (id, project_id, evidence_type, result, sample_size, confidence, source_link, observed_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, projectId, input.evidenceType, input.result.trim(), Number(input.sampleSize), input.confidence, input.sourceLink.trim(), input.observedAt, actor.id, timestamp);
      if (input.evidenceType === "metric_result") {
        this.db.prepare(`INSERT INTO project_gates (project_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason)
          VALUES (?, 'metric_evidence', 'complete', ?, ?, ?, NULL) ON CONFLICT(project_id, gate_key) DO UPDATE SET status = 'complete', evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = NULL`)
          .run(projectId, input.sourceLink.trim(), actor.id, timestamp);
      }
      this.audit(actor.id, "evidence_recorded", "evidence", id, null, { projectId, evidenceType: input.evidenceType, confidence: input.confidence });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.project(projectId);
  }

  setReview(actor, projectId, reviewType, input) {
    requireRole(actor, [roles.PLATFORM_REVIEWER, roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(projectId);
    if (![stages.INCUBATING, stages.DECISION_PENDING].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Reviews can be recorded only during incubation or decision review.", 409);
    if (!reviewTypes.includes(reviewType) || !project.reviewRequirements.includes(reviewType)) throw new WorkflowError("INVALID_REVIEW_TYPE", "This review is not required for the project risk classification.", 422);
    if (!["complete", "excepted", "incomplete"].includes(input.status)) throw new WorkflowError("INVALID_REVIEW_STATUS", "Review status is invalid.", 422);
    if (input.status === "complete") this.validateEvidenceLink(input.evidenceLink);
    if (input.status === "excepted" && !String(input.exceptionReason ?? "").trim()) throw new WorkflowError("MISSING_EXCEPTION", "An excepted review requires written risk acceptance.", 422);
    const before = project.reviews.find(review => review.reviewType === reviewType) || null;
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO project_reviews (project_id, review_type, status, evidence_link, completed_by, completed_at, exception_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, review_type) DO UPDATE SET status = excluded.status, evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = excluded.exception_reason`)
        .run(projectId, reviewType, input.status, input.evidenceLink?.trim() || null, input.status === "incomplete" ? null : actor.id, input.status === "incomplete" ? null : timestamp, input.exceptionReason?.trim() || null);
      const completed = this.reviewRequirementsMet(projectId, project.riskClassification);
      this.upsertComputedGate(projectId, "reviews_complete", completed, actor.id, input.evidenceLink?.trim() || null, timestamp);
      this.audit(actor.id, "review_updated", "project_review", `${projectId}:${reviewType}`, before, { reviewType, status: input.status, reviewsComplete: completed });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.project(projectId);
  }

  reviewRequirementsMet(projectId, riskClassification) {
    const reviews = this.db.prepare("SELECT review_type AS reviewType, status FROM project_reviews WHERE project_id = ?").all(projectId);
    return requiredReviewTypes(riskClassification).every(type => reviews.some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status)));
  }

  upsertComputedGate(projectId, key, complete, actorId, evidenceLink, timestamp) {
    const status = complete ? "complete" : "incomplete";
    this.db.prepare(`INSERT INTO project_gates (project_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason)
      VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(project_id, gate_key) DO UPDATE SET status = excluded.status, evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = NULL`)
      .run(projectId, key, status, complete ? evidenceLink : null, complete ? actorId : null, complete ? timestamp : null);
  }

  acceptHandoff(actor, projectId, input) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can accept this handoff.", 403);
    if (!project.pendingDecision || project.pendingDecision.outcome !== outcomes.TRANSFER) throw new WorkflowError("INVALID_HANDOFF_STATE", "A transfer decision request is required before handoff acceptance.", 409);
    if (!input.onboardingAcknowledged) throw new WorkflowError("ONBOARDING_REQUIRED", "Receiving owner must acknowledge onboarding before accepting handoff.", 422);
    this.validateEvidenceLink(input.adoptionPlanLink);
    this.validateFutureDate(input.supportEndDate, "Support end date");
    this.validateFutureDate(input.followUpDate, "Follow-up date");
    const timestamp = now();
    const existing = this.db.prepare("SELECT status FROM handoffs WHERE project_id = ?").get(projectId);
    if (existing?.status === "accepted") throw new WorkflowError("HANDOFF_ALREADY_ACCEPTED", "This handoff has already been accepted.", 409);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO handoffs (project_id, receiving_owner_id, status, adoption_plan_link, support_end_date, follow_up_date, onboarding_acknowledged, accepted_by, accepted_at)
        VALUES (?, ?, 'accepted', ?, ?, ?, 1, ?, ?) ON CONFLICT(project_id) DO UPDATE SET status = 'accepted', adoption_plan_link = excluded.adoption_plan_link, support_end_date = excluded.support_end_date, follow_up_date = excluded.follow_up_date, onboarding_acknowledged = 1, accepted_by = excluded.accepted_by, accepted_at = excluded.accepted_at`)
        .run(projectId, actor.id, input.adoptionPlanLink.trim(), input.supportEndDate, input.followUpDate, actor.id, timestamp);
      for (const [key, link] of [["receiving_owner_ack", input.adoptionPlanLink.trim()], ["support_plan", input.adoptionPlanLink.trim()], ["follow_up_scheduled", input.adoptionPlanLink.trim()]]) {
        this.db.prepare(`INSERT INTO project_gates (project_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason)
          VALUES (?, ?, 'complete', ?, ?, ?, NULL) ON CONFLICT(project_id, gate_key) DO UPDATE SET status = 'complete', evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = NULL`)
          .run(projectId, key, link, actor.id, timestamp);
      }
      this.audit(actor.id, "handoff_accepted", "handoff", projectId, existing || null, { status: "accepted", supportEndDate: input.supportEndDate, followUpDate: input.followUpDate });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
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
    if (!String(input.rationale ?? '').trim()) throw new WorkflowError("MISSING_RATIONALE", "A decision rationale is required.", 422);
    const open = this.db.prepare("SELECT id FROM decisions WHERE project_id = ? AND status IN ('requested', 'approved')").get(projectId);
    if (open) throw new WorkflowError("PENDING_DECISION", "A decision is already awaiting approval.", 409);
    const id = randomUUID(); const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO decisions (id, project_id, outcome, rationale, status, requested_by, requested_at) VALUES (?, ?, ?, ?, 'requested', ?, ?)").run(id, projectId, input.outcome, input.rationale.trim(), actor.id, timestamp);
      this.db.prepare("UPDATE projects SET stage = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stages.DECISION_PENDING, timestamp, actor.id, projectId);
      this.audit(actor.id, "decision_requested", "decision", id, null, { projectId, outcome: input.outcome, missingGates: missingGates(input.outcome, project.gates) });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.decision(id);
  }

  decision(id) {
    const decision = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
    if (!decision) throw new WorkflowError("NOT_FOUND", "Decision not found.", 404);
    const project = this.project(decision.project_id);
    const approvals = this.db.prepare("SELECT approver_id AS approverId, approver_role AS approverRole, result, comment, created_at AS createdAt FROM approvals WHERE decision_id = ? ORDER BY created_at").all(id);
    return { id: decision.id, projectId: decision.project_id, outcome: decision.outcome, rationale: decision.rationale, status: decision.status, requestedBy: decision.requested_by, requestedAt: decision.requested_at, finalizedBy: decision.finalized_by, finalizedAt: decision.finalized_at, approvals, missingGates: missingGates(decision.outcome, project.gates), requiredApprovers: requiredApproverRoles(decision.outcome, project) };
  }

  approveDecision(actor, id, input) {
    const decision = this.decision(id);
    if (decision.status !== 'requested') throw new WorkflowError("INVALID_DECISION_STATE", "Only requested decisions can be approved.", 409);
    if (decision.requestedBy === actor.id) throw new WorkflowError("SELF_APPROVAL", "A requester cannot approve their own decision.", 403);
    if (!decision.requiredApprovers.includes(actor.role)) throw new WorkflowError("FORBIDDEN", "You are not a required approver for this decision.", 403);
    if (!['approved', 'rejected'].includes(input.result)) throw new WorkflowError("INVALID_APPROVAL", "Approval result is invalid.", 422);
    if (!String(input.comment ?? '').trim()) throw new WorkflowError("MISSING_APPROVAL_COMMENT", "An approval comment is required.", 422);
    const existing = this.db.prepare("SELECT id FROM approvals WHERE decision_id = ? AND approver_role = ?").get(id, actor.role);
    if (existing) throw new WorkflowError("DUPLICATE_APPROVAL", "This approval role has already responded.", 409);
    const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO approvals (id, decision_id, approver_id, approver_role, result, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), id, actor.id, actor.role, input.result, input.comment.trim(), timestamp);
      if (input.result === "rejected") {
        this.db.prepare("UPDATE decisions SET status = 'rejected', finalized_by = ?, finalized_at = ? WHERE id = ?").run(actor.id, timestamp, id);
        this.db.prepare("UPDATE projects SET stage = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stages.INCUBATING, timestamp, actor.id, decision.projectId);
        this.audit(actor.id, "decision_rejected", "decision", id, { stage: stages.DECISION_PENDING }, { stage: stages.INCUBATING, role: actor.role, comment: input.comment.trim() });
      } else {
        this.audit(actor.id, "decision_approved", "decision", id, null, { result: input.result, role: actor.role });
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.decision(id);
  }

  finalizeDecision(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const decision = this.decision(id);
    if (decision.status !== 'requested') throw new WorkflowError("INVALID_DECISION_STATE", "Only requested decisions can be finalized.", 409);
    const rejected = decision.approvals.find(approval => approval.result === 'rejected');
    if (rejected) throw new WorkflowError("DECISION_REJECTED", "A required approver rejected this decision.", 409, { rejectedBy: rejected.approverRole });
    const approvedRoles = new Set(decision.approvals.filter(approval => approval.result === 'approved').map(approval => approval.approverRole));
    const missingApprovals = decision.requiredApprovers.filter(role => !approvedRoles.has(role));
    if (missingApprovals.length) throw new WorkflowError("MISSING_APPROVALS", "Required approvals are incomplete.", 409, { missingApprovals });
    if (decision.missingGates.length) throw new WorkflowError("MISSING_GATES", "Decision gates are incomplete.", 409, { missingGates: decision.missingGates });
    const project = this.project(decision.projectId);
    const stage = finalStage(decision.outcome); const timestamp = now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE projects SET stage = ?, extension_count = extension_count + ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stage, decision.outcome === outcomes.EXTEND ? 1 : 0, timestamp, actor.id, project.id);
      this.db.prepare("UPDATE decisions SET status = 'finalized', finalized_by = ?, finalized_at = ? WHERE id = ?").run(actor.id, timestamp, id);
      this.audit(actor.id, "decision_finalized", "decision", id, { stage: project.stage }, { stage, outcome: decision.outcome });
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { decision: this.decision(id), project: this.project(project.id) };
  }

  auditEvents(actor, limit = 100) {
    requireRole(actor, [roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.ADMIN]);
    return this.db.prepare("SELECT id, actor_id AS actorId, action, entity_type AS entityType, entity_id AS entityId, before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit)
      .map(event => ({ ...event, before: event.beforeJson ? parse(event.beforeJson) : null, after: event.afterJson ? parse(event.afterJson) : null, beforeJson: undefined, afterJson: undefined }));
  }

  // Storage port implementation. These methods deliberately contain only
  // persistence concerns; WorkflowService owns authorization and transitions.
  getActor(id) { return this.actor(id); }
  listUsers() { return this.users(); }
  getProject(id) { return this.project(id); }
  listProjects() {
    const rows = this.db.prepare(`SELECT p.*, sponsor.name AS sponsor_name, receiver.name AS receiving_owner_name, lead.name AS project_lead_name
      FROM projects p JOIN users sponsor ON sponsor.id = p.sponsor_id LEFT JOIN users receiver ON receiver.id = p.receiving_owner_id
      JOIN users lead ON lead.id = p.project_lead_id WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC`).all();
    return rows.map(row => this.serializeProject(row));
  }
  appendAudit(actorId, action, entityType, entityId, before, after) { this.audit(actorId, action, entityType, entityId, before, after); }

  transaction(work) {
    this.db.exec("BEGIN");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  insertProject(project) {
    this.db.prepare(`INSERT INTO projects (
      id, cycle_id, title, stage, origin_team, target_users, potential_reach, problem, metric, baseline, target, metric_source, metric_owner_id,
      sponsor_id, receiving_owner_id, project_lead_id, risk_classification, transfer_date, shared_platform_impact, created_at, created_by, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(project.id, project.cycleId, project.title, project.stage, project.originTeam, project.users, project.potentialReach, project.problem, project.metric, project.baseline, project.target, project.metricSource, project.metricOwnerId, project.sponsorId, project.receivingOwnerId, project.projectLeadId, project.riskClassification, project.transferDate, project.sharedPlatformImpact ? 1 : 0, project.createdAt, project.createdBy, project.updatedAt, project.updatedBy);
  }

  insertIntakeDraft(draft) {
    this.db.prepare(`INSERT INTO intake_drafts (
      id, status, owner_id, collaborator_ids_json, content_json, created_at, created_by, updated_at, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(draft.id, draft.status, draft.ownerId, json([]), json(draft.content), draft.createdAt, draft.createdBy, draft.updatedAt, draft.updatedBy);
  }

  updateIntakeDraft(id, draft) {
    this.db.prepare("UPDATE intake_drafts SET content_json = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(json(draft.content), draft.updatedAt, draft.updatedBy, id);
  }

  updateIntakeDraftStatus(id, status, timestamp, actorId) {
    this.db.prepare("UPDATE intake_drafts SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(status, timestamp, actorId, id);
  }

  insertIntakeDraftCollaborator(draftId, collaborator) {
    this.db.prepare("INSERT INTO intake_draft_collaborators (draft_id, collaborator_id, permission, added_at, added_by) VALUES (?, ?, ?, ?, ?)")
      .run(draftId, collaborator.userId, collaborator.permission, collaborator.addedAt, collaborator.addedBy);
  }

  deleteIntakeDraftCollaborator(draftId, collaboratorId) {
    this.db.prepare("DELETE FROM intake_draft_collaborators WHERE draft_id = ? AND collaborator_id = ?").run(draftId, collaboratorId);
  }

  listTriageComments(projectId) {
    return this.db.prepare(`SELECT id, project_id AS projectId, author_id AS authorId, comment_kind AS kind, comment_text AS comment, created_at AS createdAt
      FROM project_triage_comments WHERE project_id = ? ORDER BY created_at, rowid`).all(projectId);
  }

  insertTriageComment(comment) {
    this.db.prepare("INSERT INTO project_triage_comments (id, project_id, author_id, comment_kind, comment_text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(comment.id, comment.projectId, comment.authorId, comment.kind, comment.comment, comment.createdAt);
  }

  updateProjectTriageStatus(projectId, triageStatus, actorId, timestamp) {
    this.db.prepare("UPDATE projects SET triage_status = ?, information_requested_by = ?, information_requested_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .run(triageStatus, actorId, timestamp, timestamp, actorId, projectId);
  }

  updateProjectStage(id, stage, actorId, timestamp) {
    this.db.prepare("UPDATE projects SET stage = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stage, timestamp, actorId, id);
  }

  getProjectIncludingDeleted(id) {
    const row = this.db.prepare(`SELECT p.*, sponsor.name AS sponsor_name, receiver.name AS receiving_owner_name, lead.name AS project_lead_name
      FROM projects p JOIN users sponsor ON sponsor.id = p.sponsor_id LEFT JOIN users receiver ON receiver.id = p.receiving_owner_id
      JOIN users lead ON lead.id = p.project_lead_id WHERE p.id = ?`).get(id);
    if (!row) throw new WorkflowError("NOT_FOUND", "Project not found.", 404);
    return this.serializeProject(row);
  }

  softDeleteProject(id, actorId, reason, timestamp) {
    this.db.prepare("UPDATE projects SET deleted_at = ?, deleted_by = ?, deletion_reason = ?, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL")
      .run(timestamp, actorId, reason, timestamp, actorId, id);
  }

  projectRetentionUntil(id) {
    return this.db.prepare("SELECT retention_until FROM decisions WHERE project_id = ? AND status = 'finalized' AND retention_until IS NOT NULL ORDER BY retention_until DESC LIMIT 1").get(id)?.retention_until || null;
  }

  restoreProject(id, actorId, timestamp) {
    this.db.prepare("UPDATE projects SET deleted_at = NULL, deleted_by = NULL, deletion_reason = NULL, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NOT NULL")
      .run(timestamp, actorId, id);
  }

  acknowledgeProjectAdoption(projectId, actorId, timestamp) {
    this.db.prepare("UPDATE projects SET adoption_acknowledged_by = ?, adoption_acknowledged_at = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(actorId, timestamp, timestamp, actorId, projectId);
  }

  upsertGate(gate) {
    this.db.prepare(`INSERT INTO project_gates (project_id, gate_key, status, evidence_link, completed_by, completed_at, exception_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, gate_key) DO UPDATE SET status = excluded.status, evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = excluded.exception_reason`)
      .run(gate.projectId, gate.key, gate.status, gate.evidenceLink, gate.completedBy, gate.completedAt, gate.exceptionReason);
  }

  insertEvidence(evidence) {
    this.db.prepare("INSERT INTO evidence_entries (id, project_id, evidence_type, result, sample_size, confidence, source_link, observed_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(evidence.id, evidence.projectId, evidence.evidenceType, evidence.result, evidence.sampleSize, evidence.confidence, evidence.sourceLink, evidence.observedAt, evidence.createdBy, evidence.createdAt);
  }

  upsertReview(review) {
    this.db.prepare(`INSERT INTO project_reviews (project_id, review_type, status, evidence_link, completed_by, completed_at, exception_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, review_type) DO UPDATE SET status = excluded.status, evidence_link = excluded.evidence_link, completed_by = excluded.completed_by, completed_at = excluded.completed_at, exception_reason = excluded.exception_reason`)
      .run(review.projectId, review.reviewType, review.status, review.evidenceLink, review.completedBy, review.completedAt, review.exceptionReason);
  }

  listReviews(projectId) {
    return this.db.prepare("SELECT review_type AS reviewType, status, evidence_link AS evidenceLink, completed_by AS completedBy, completed_at AS completedAt, exception_reason AS exceptionReason FROM project_reviews WHERE project_id = ? ORDER BY review_type").all(projectId);
  }

  getHandoff(projectId) {
    const handoff = this.db.prepare("SELECT project_id AS projectId, receiving_owner_id AS receivingOwnerId, status, adoption_plan_link AS adoptionPlanLink, support_end_date AS supportEndDate, follow_up_date AS followUpDate, onboarding_acknowledged AS onboardingAcknowledged, accepted_by AS acceptedBy, accepted_at AS acceptedAt FROM handoffs WHERE project_id = ?").get(projectId);
    return handoff ? { ...handoff, onboardingAcknowledged: Boolean(handoff.onboardingAcknowledged) } : null;
  }

  upsertHandoff(handoff) {
    this.db.prepare(`INSERT INTO handoffs (project_id, receiving_owner_id, status, adoption_plan_link, support_end_date, follow_up_date, onboarding_acknowledged, accepted_by, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET status = excluded.status, adoption_plan_link = excluded.adoption_plan_link, support_end_date = excluded.support_end_date, follow_up_date = excluded.follow_up_date, onboarding_acknowledged = excluded.onboarding_acknowledged, accepted_by = excluded.accepted_by, accepted_at = excluded.accepted_at`)
      .run(handoff.projectId, handoff.receivingOwnerId, handoff.status, handoff.adoptionPlanLink, handoff.supportEndDate, handoff.followUpDate, handoff.onboardingAcknowledged ? 1 : 0, handoff.acceptedBy, handoff.acceptedAt);
  }

  findOpenDecision(projectId) { return this.db.prepare("SELECT id FROM decisions WHERE project_id = ? AND status IN ('requested', 'approved')").get(projectId) || null; }

  insertDecision(decision) {
    this.db.prepare("INSERT INTO decisions (id, project_id, outcome, rationale, status, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(decision.id, decision.projectId, decision.outcome, decision.rationale, decision.status, decision.requestedBy, decision.requestedAt);
  }

  getDecision(id) {
    const decision = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
    return decision ? { id: decision.id, projectId: decision.project_id, outcome: decision.outcome, rationale: decision.rationale, status: decision.status, requestedBy: decision.requested_by, requestedAt: decision.requested_at, finalizedBy: decision.finalized_by, finalizedAt: decision.finalized_at } : null;
  }

  listApprovals(decisionId) {
    return this.db.prepare("SELECT approver_id AS approverId, approver_role AS approverRole, result, comment, created_at AS createdAt FROM approvals WHERE decision_id = ? ORDER BY created_at").all(decisionId);
  }

  insertApproval(approval) {
    this.db.prepare("INSERT INTO approvals (id, decision_id, approver_id, approver_role, result, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(approval.id, approval.decisionId, approval.approverId, approval.approverRole, approval.result, approval.comment, approval.createdAt);
  }

  rejectDecision(id, actorId, timestamp, projectId, stage) {
    this.db.prepare("UPDATE decisions SET status = 'rejected', finalized_by = ?, finalized_at = ? WHERE id = ?").run(actorId, timestamp, id);
    this.updateProjectStage(projectId, stage, actorId, timestamp);
  }

  finalizeDecision(id, actorId, timestamp, projectId, stage, extensionIncrement, retentionUntilValue) {
    this.db.prepare("UPDATE projects SET stage = ?, extension_count = extension_count + ?, updated_at = ?, updated_by = ? WHERE id = ?").run(stage, extensionIncrement, timestamp, actorId, projectId);
    this.db.prepare("UPDATE decisions SET status = 'finalized', finalized_by = ?, finalized_at = ?, retention_classification = ?, retention_until = ? WHERE id = ?").run(actorId, timestamp, retentionClassification, retentionUntilValue, id);
  }

  listAuditEvents(limit) {
    return this.db.prepare("SELECT id, actor_id AS actorId, action, entity_type AS entityType, entity_id AS entityId, before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt, audit_sequence AS auditSequence, previous_hash AS previousHash, event_hash AS eventHash FROM audit_events ORDER BY audit_sequence DESC LIMIT ?").all(limit)
      .map(event => ({ ...event, before: event.beforeJson ? parse(event.beforeJson) : null, after: event.afterJson ? parse(event.afterJson) : null, beforeJson: undefined, afterJson: undefined }));
  }

  verifyAuditIntegrity() { return verifyAuditChain(this.listAuditEvents(Number.MAX_SAFE_INTEGER).reverse()); }

  health() {
    return this.db.prepare("SELECT 1 AS ok").get().ok === 1;
  }

  close() { this.db.close(); }
}

/** Compatibility facade used by the HTTP runtime and existing tests. */
export class LabsStore extends WorkflowService {
  constructor(file, options = {}) {
    const storage = new SqliteLabsStorage(file, options);
    super(storage, options);
  }

  health() { return this.storage.health(); }
  close() { this.storage.close(); }
}
