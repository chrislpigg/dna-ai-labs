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
    await tx.insertIntakeDraft({ id: "draft-1", status: "Draft", ownerId: "user-1", collaboratorIds: ["user-2"], content: { title: "Early draft" }, createdAt: "2026-06-20T00:00:00.000Z", createdBy: "user-1", updatedAt: "2026-06-20T00:00:00.000Z", updatedBy: "user-1" });
    await tx.updateIntakeDraft("draft-1", { collaboratorIds: ["user-2"], content: { title: "Updated draft" }, updatedAt: "2026-06-20T01:00:00.000Z", updatedBy: "user-2" });
    await tx.insertProject({ id: "project-1", cycleId: "cycle-1", title: "Release evidence", stage: "Submitted", originTeam: "Developer Experience", users: "Release leads", potentialReach: 3, problem: "Evidence is fragmented.", metric: "Review duration", baseline: "3 hours", target: "1 hour", metricSource: "Tracker", metricOwnerId: "user-1", sponsorId: "user-2", receivingOwnerId: "user-3", projectLeadId: "user-1", riskClassification: "Internal", transferDate: "2026-12-18", sharedPlatformImpact: false, createdAt: "2026-06-20T00:00:00.000Z", createdBy: "user-1", updatedAt: "2026-06-20T00:00:00.000Z", updatedBy: "user-1" });
    await tx.insertEvidence({ id: "evidence-1", projectId: "project-1", evidenceType: "metric_result", result: "Faster", sampleSize: 12, confidence: "high", sourceLink: "https://docs.example/metric", observedAt: "2026-06-19", createdBy: "user-1", createdAt: "2026-06-20T00:00:00.000Z" });
    await tx.upsertReview({ projectId: "project-1", reviewType: "accessibility", status: "complete", evidenceLink: "https://docs.example/review", completedBy: "user-1", completedAt: "2026-06-20T00:00:00.000Z", exceptionReason: null });
    await tx.insertDecision({ id: "decision-1", projectId: "project-1", outcome: "Scale", rationale: "Measured result", status: "requested", requestedBy: "user-1", requestedAt: "2026-06-20T00:00:00.000Z" });
    await tx.insertApproval({ id: "approval-1", decisionId: "decision-1", approverId: "user-2", approverRole: "lab-lead", result: "approved", comment: "Reviewed", createdAt: "2026-06-20T00:00:00.000Z" });
    await tx.upsertHandoff({ projectId: "project-1", receivingOwnerId: "user-3", status: "accepted", adoptionPlanLink: "https://docs.example/adoption", supportEndDate: "2026-12-18", followUpDate: "2026-12-20", onboardingAcknowledged: true, acceptedBy: "user-3", acceptedAt: "2026-06-20T00:00:00.000Z" });
    await tx.appendAudit("user-1", "workflow_mutation", "project", "project-1", null, { state: "written" });
  });

  const sql = client.calls.map(call => call.sql);
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql.at(-1), "COMMIT");
  for (const table of ["intake_drafts", "projects", "evidence_entries", "project_reviews", "decisions", "approvals", "handoffs", "audit_events"]) assert.equal(sql.some(statement => statement.includes(`INSERT INTO ${table}`)), true);
  assert.equal(sql.some(statement => statement.includes("UPDATE intake_drafts")), true);
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
