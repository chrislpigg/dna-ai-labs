import { randomUUID } from "node:crypto";
import { assertStoragePort } from "./storage-port.mjs";
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

/** Server-owned governed workflow. It is intentionally independent of SQLite. */
export class WorkflowService {
  constructor(storage, { approvedArtifactOrigins = ["https://intranet.example"] } = {}) {
    this.storage = assertStoragePort(storage);
    this.approvedArtifactOrigins = new Set(approvedArtifactOrigins);
  }

  actor(id) { return this.storage.getActor(id); }
  users() { return this.storage.listUsers(); }
  project(id) { return this.storage.getProject(id); }
  listProjects() { return this.storage.listProjects(); }

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
    this.storage.transaction(() => {
      this.storage.insertProject({
        id, cycleId: input.cycleId || "cycle-2026-q3", title: input.title.trim(), stage: stages.SUBMITTED,
        originTeam: input.originTeam.trim(), users: input.users.trim(), potentialReach: Number(input.potentialReach),
        problem: input.problem.trim(), metric: input.metric.trim(), baseline: input.baseline.trim(), target: input.target.trim(),
        metricSource: input.metricSource.trim(), metricOwnerId: input.metricOwnerId, sponsorId: input.sponsorId,
        receivingOwnerId: input.receivingOwnerId || null, projectLeadId: input.projectLeadId,
        riskClassification: input.riskClassification, transferDate: input.transferDate || null,
        sharedPlatformImpact: Boolean(input.sharedPlatformImpact), createdAt: timestamp, createdBy: actor.id, updatedAt: timestamp, updatedBy: actor.id
      });
      this.storage.appendAudit(actor.id, "intake_submitted", "project", id, null, { stage: stages.SUBMITTED, title: input.title.trim() });
    });
    return this.project(id);
  }

  selectProject(actor, id) {
    requireRole(actor, [roles.LAB_LEAD, roles.ADMIN]);
    const project = this.project(id);
    if (![stages.SUBMITTED, stages.TRIAGE].includes(project.stage)) throw new WorkflowError("INVALID_STATE", "Only submitted or triaged projects can be selected.", 409);
    if (!project.receivingOwner) throw new WorkflowError("MISSING_RECEIVING_OWNER", "Selection requires a named receiving owner.", 409);
    if (!project.adoptionAcknowledged) throw new WorkflowError("MISSING_ADOPTION_ACK", "Selection requires acknowledgement from the named receiving owner.", 409);
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
    if (input.status === "complete") this.validateEvidenceLink(input.evidenceLink);
    const before = project.gates.find(gate => gate.key === key) || null; const timestamp = now();
    this.storage.transaction(() => {
      this.storage.upsertGate({ projectId, key, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null });
      this.storage.appendAudit(actor.id, "gate_updated", "project_gate", `${projectId}:${key}`, before, { key, status: input.status });
    });
    return this.project(projectId);
  }

  validateEvidenceLink(value) {
    let url;
    try { url = new URL(value); } catch { throw new WorkflowError("INVALID_EVIDENCE_LINK", "Evidence must be a valid approved URL.", 422); }
    if (!this.approvedArtifactOrigins.has(url.origin)) throw new WorkflowError("UNAPPROVED_EVIDENCE_LINK", "Evidence must link to an approved internal system.", 422);
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
    this.validateEvidenceLink(input.sourceLink);
    const observed = new Date(`${input.observedAt}T12:00:00`);
    if (!input.observedAt || Number.isNaN(observed.getTime()) || observed > new Date()) throw new WorkflowError("INVALID_OBSERVED_DATE", "Evidence date must be today or earlier.", 422);
    const id = randomUUID(); const timestamp = now();
    this.storage.transaction(() => {
      this.storage.insertEvidence({ id, projectId, evidenceType: input.evidenceType, result: input.result.trim(), sampleSize: Number(input.sampleSize), confidence: input.confidence, sourceLink: input.sourceLink.trim(), observedAt: input.observedAt, createdBy: actor.id, createdAt: timestamp });
      if (input.evidenceType === "metric_result") this.storage.upsertGate({ projectId, key: "metric_evidence", status: "complete", evidenceLink: input.sourceLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null });
      this.storage.appendAudit(actor.id, "evidence_recorded", "evidence", id, null, { projectId, evidenceType: input.evidenceType, confidence: input.confidence });
    });
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
    const before = project.reviews.find(review => review.reviewType === reviewType) || null; const timestamp = now();
    this.storage.transaction(() => {
      this.storage.upsertReview({ projectId, reviewType, status: input.status, evidenceLink: input.evidenceLink?.trim() || null, completedBy: input.status === "incomplete" ? null : actor.id, completedAt: input.status === "incomplete" ? null : timestamp, exceptionReason: input.exceptionReason?.trim() || null });
      const complete = project.reviewRequirements.every(type => this.storage.listReviews(projectId).some(review => review.reviewType === type && ["complete", "excepted"].includes(review.status)));
      this.storage.upsertGate({ projectId, key: "reviews_complete", status: complete ? "complete" : "incomplete", evidenceLink: complete ? input.evidenceLink?.trim() || null : null, completedBy: complete ? actor.id : null, completedAt: complete ? timestamp : null, exceptionReason: null });
      this.storage.appendAudit(actor.id, "review_updated", "project_review", `${projectId}:${reviewType}`, before, { reviewType, status: input.status, reviewsComplete: complete });
    });
    return this.project(projectId);
  }

  acceptHandoff(actor, projectId, input) {
    requireRole(actor, [roles.RECEIVING_OWNER]);
    const project = this.project(projectId);
    if (!project.receivingOwner || project.receivingOwner.id !== actor.id) throw new WorkflowError("FORBIDDEN", "Only the named receiving owner can accept this handoff.", 403);
    if (!project.pendingDecision || project.pendingDecision.outcome !== outcomes.TRANSFER) throw new WorkflowError("INVALID_HANDOFF_STATE", "A transfer decision request is required before handoff acceptance.", 409);
    if (!input.onboardingAcknowledged) throw new WorkflowError("ONBOARDING_REQUIRED", "Receiving owner must acknowledge onboarding before accepting handoff.", 422);
    this.validateEvidenceLink(input.adoptionPlanLink); this.validateFutureDate(input.supportEndDate, "Support end date"); this.validateFutureDate(input.followUpDate, "Follow-up date");
    const timestamp = now(); const existing = this.storage.getHandoff(projectId);
    if (existing?.status === "accepted") throw new WorkflowError("HANDOFF_ALREADY_ACCEPTED", "This handoff has already been accepted.", 409);
    this.storage.transaction(() => {
      this.storage.upsertHandoff({ projectId, receivingOwnerId: actor.id, status: "accepted", adoptionPlanLink: input.adoptionPlanLink.trim(), supportEndDate: input.supportEndDate, followUpDate: input.followUpDate, onboardingAcknowledged: true, acceptedBy: actor.id, acceptedAt: timestamp });
      for (const key of ["receiving_owner_ack", "support_plan", "follow_up_scheduled"]) this.storage.upsertGate({ projectId, key, status: "complete", evidenceLink: input.adoptionPlanLink.trim(), completedBy: actor.id, completedAt: timestamp, exceptionReason: null });
      this.storage.appendAudit(actor.id, "handoff_accepted", "handoff", projectId, existing || null, { status: "accepted", supportEndDate: input.supportEndDate, followUpDate: input.followUpDate });
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
      this.storage.appendAudit(actor.id, "decision_requested", "decision", id, null, { projectId, outcome: input.outcome, missingGates: missingGates(input.outcome, project.gates) });
    });
    return this.decision(id);
  }

  decision(id) {
    const decision = this.storage.getDecision(id);
    if (!decision) throw new WorkflowError("NOT_FOUND", "Decision not found.", 404);
    const project = this.project(decision.projectId);
    return { ...decision, approvals: this.storage.listApprovals(id), missingGates: missingGates(decision.outcome, project.gates), requiredApprovers: requiredApproverRoles(decision.outcome, project) };
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
      this.storage.finalizeDecision(id, actor.id, timestamp, project.id, stage, decision.outcome === outcomes.EXTEND ? 1 : 0);
      this.storage.appendAudit(actor.id, "decision_finalized", "decision", id, { stage: project.stage }, { stage, outcome: decision.outcome });
    });
    return { decision: this.decision(id), project: this.project(project.id) };
  }

  auditEvents(actor, limit = 100) {
    requireRole(actor, [roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.ADMIN]);
    return this.storage.listAuditEvents(limit);
  }
}
