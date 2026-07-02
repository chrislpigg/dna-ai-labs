import test from "node:test";
import assert from "node:assert/strict";
import { PostgresWorkflowAdapter } from "../src/postgres-workflow-adapter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

class TransactionClientMock {
  constructor({ failAudit = false } = {}) { this.calls = []; this.failAudit = failAudit; this.released = false; }
  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (this.failAudit && sql.includes("INSERT INTO audit_events")) throw new Error("audit unavailable");
    return { rows: [], rowCount: 1 };
  }
  release() { this.released = true; }
}

class PoolMock {
  constructor(client) { this.client = client; this.readCalls = []; }
  async connect() { return this.client; }
  async query(sql, params = []) { this.readCalls.push({ sql, params }); return { rows: [] }; }
}

test("PostgreSQL workflow writes project, evidence, review, decision, approval, and handoff state with its audit event in one transaction", async () => {
  const client = new TransactionClientMock();
  const adapter = new PostgresWorkflowAdapter({ queryable: new PoolMock(client), organizationId: "org-a" });
  await adapter.transaction(async tx => {
    await tx.insertCycle({ id: "cycle-1", name: "Cycle 02", theme: "Operational readiness", startsOn: "2026-10-01", endsOn: "2026-12-31", capacityUnits: 4, steeringGroupIds: ["lab-lead"], status: "planned" });
    await tx.updateCycle("cycle-1", { name: "Cycle 02", theme: "Operational readiness", startsOn: "2026-10-01", endsOn: "2026-12-31", capacityUnits: 5, steeringGroupIds: ["lab-lead", "executive-sponsor"], status: "active" });
    await tx.upsertFeatureFlag({ key: "intake_resubmission", enabled: false, updatedAt: "2026-06-20T00:00:00.000Z", updatedBy: "admin" });
    await tx.upsertRoleAssignment({ userId: "user-4", role: "submitter", active: true, assignedBy: "admin", assignedAt: "2026-06-20T00:00:00.000Z" });
    await tx.insertIntakeDraft({ id: "draft-1", status: "Draft", ownerId: "user-1", collaboratorIds: ["user-2"], content: { title: "Early draft" }, createdAt: "2026-06-20T00:00:00.000Z", createdBy: "user-1", updatedAt: "2026-06-20T00:00:00.000Z", updatedBy: "user-1" });
    await tx.insertIntakeDraftCollaborator("draft-1", { userId: "user-2", permission: "edit", addedAt: "2026-06-20T00:00:00.000Z", addedBy: "user-1" });
    await tx.updateIntakeDraft("draft-1", { content: { title: "Updated draft" }, updatedAt: "2026-06-20T01:00:00.000Z", updatedBy: "user-2" });
    await tx.updateIntakeDraftStatus("draft-1", "Submitted", "2026-06-20T02:00:00.000Z", "user-1");
    await tx.deleteIntakeDraftCollaborator("draft-1", "user-2");
    await tx.insertProject({ id: "project-1", cycleId: "cycle-1", title: "Release evidence", stage: "Submitted", originTeam: "Developer Experience", users: "Release leads", potentialReach: 3, problem: "Evidence is fragmented.", metric: "Review duration", baseline: "3 hours", target: "1 hour", metricSource: "Tracker", metricOwnerId: "user-1", sponsorId: "user-2", receivingOwnerId: "user-3", projectLeadId: "user-1", riskClassification: "Internal", transferDate: "2026-12-18", sharedPlatformImpact: false, createdAt: "2026-06-20T00:00:00.000Z", createdBy: "user-1", updatedAt: "2026-06-20T00:00:00.000Z", updatedBy: "user-1" });
    await tx.insertIntakeRevision({ id: "revision-1", projectId: "project-1", revisionNumber: 1, content: { title: "Release evidence" }, submittedBy: "user-1", submittedAt: "2026-06-20T00:00:00.000Z" });
    await tx.updateProjectIntakeContent("project-1", { cycleId: "cycle-1", title: "Release evidence updated", originTeam: "Developer Experience", users: "Release leads", potentialReach: 5, problem: "Evidence is fragmented.", metric: "Review duration", baseline: "3 hours", target: "45 minutes", metricSource: "Tracker", metricOwnerId: "user-1", sponsorId: "user-2", receivingOwnerId: "user-3", projectLeadId: "user-1", riskClassification: "Internal", transferDate: "2026-12-18", sharedPlatformImpact: false }, "user-1", "2026-06-20T00:15:00.000Z");
    await tx.cycleCapacityUsage("cycle-1", ["Selected", "Incubating"]);
    await tx.insertTriageComment({ id: "comment-1", projectId: "project-1", authorId: "user-2", kind: "request_for_information", comment: "Clarify the pilot cohort.", createdAt: "2026-06-20T00:30:00.000Z" });
    await tx.updateProjectTriageStatus("project-1", "information_requested", "user-2", "2026-06-20T00:30:00.000Z");
    await tx.insertEvidence({ id: "evidence-1", projectId: "project-1", evidenceType: "metric_result", result: "Faster", sampleSize: 12, confidence: "high", sourceLink: "https://docs.example/metric", observedAt: "2026-06-19", createdBy: "user-1", createdAt: "2026-06-20T00:00:00.000Z" });
    await tx.upsertReview({ projectId: "project-1", reviewType: "accessibility", status: "complete", evidenceLink: "https://docs.example/review", completedBy: "user-1", completedAt: "2026-06-20T00:00:00.000Z", exceptionReason: null });
    await tx.insertDecision({ id: "decision-1", projectId: "project-1", outcome: "Scale", rationale: "Measured result", status: "requested", requestedBy: "user-1", requestedAt: "2026-06-20T00:00:00.000Z" });
    await tx.insertApproval({ id: "approval-1", decisionId: "decision-1", approverId: "user-2", approverRole: "lab-lead", result: "approved", comment: "Reviewed", createdAt: "2026-06-20T00:00:00.000Z" });
    await tx.upsertHandoff({ projectId: "project-1", receivingOwnerId: "user-3", status: "accepted", adoptionPlanLink: "https://docs.example/adoption", supportEndDate: "2026-12-18", followUpDate: "2026-12-20", onboardingAcknowledged: true, acceptedBy: "user-3", acceptedAt: "2026-06-20T00:00:00.000Z" });
    await tx.softDeleteProject("project-1", "user-1", "withdrawn", "2026-06-20T03:00:00.000Z");
    await tx.appendAudit("user-1", "workflow_mutation", "project", "project-1", null, { state: "written" });
  });

  const sql = client.calls.map(call => call.sql);
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql.at(-1), "COMMIT");
  for (const table of ["cycles", "feature_flags", "role_assignments", "intake_drafts", "intake_draft_collaborators", "projects", "intake_revisions", "project_triage_comments", "evidence_entries", "project_reviews", "decisions", "approvals", "handoffs", "audit_events"]) assert.equal(sql.some(statement => statement.includes(`INSERT INTO ${table}`)), true);
  assert.equal(sql.some(statement => statement.includes("UPDATE cycles")), true);
  assert.equal(sql.some(statement => statement.includes("UPDATE intake_drafts")), true);
  assert.equal(sql.some(statement => statement.includes("target = $11")), true);
  assert.equal(sql.some(statement => statement.includes("SUM(capacity_units)")), true);
  assert.equal(sql.some(statement => statement.includes("triage_status")), true);
  assert.equal(sql.some(statement => statement.includes("SET status = $3")), true);
  assert.equal(sql.some(statement => statement.includes("deletion_reason")), true);
  assert.equal(sql.some(statement => statement.includes("DELETE FROM intake_draft_collaborators")), true);
  for (const call of client.calls.slice(1, -1)) assert.equal(call.params.includes("org-a"), true);
  assert.equal(client.released, true);
});

test("a failed audit write rolls back the workflow write and does not commit partial state", async () => {
  const client = new TransactionClientMock({ failAudit: true });
  const adapter = new PostgresWorkflowAdapter({ queryable: new PoolMock(client), organizationId: "org-a" });
  await assert.rejects(
    () => adapter.transaction(async tx => {
      await tx.insertEvidence({ id: "evidence-1", projectId: "project-1", evidenceType: "metric_result", result: "Faster", sampleSize: 12, confidence: "high", sourceLink: "https://docs.example/metric", observedAt: "2026-06-19", createdBy: "user-1", createdAt: "2026-06-20T00:00:00.000Z" });
      await tx.appendAudit("user-1", "evidence_recorded", "evidence", "evidence-1", null, { projectId: "project-1" });
    }),
    error => error instanceof WorkflowError && error.code === "DATABASE_UNAVAILABLE"
  );
  assert.equal(client.calls[0].sql, "BEGIN");
  assert.equal(client.calls.some(call => call.sql === "COMMIT"), false);
  assert.equal(client.calls.at(-1).sql, "ROLLBACK");
  assert.equal(client.released, true);
});
