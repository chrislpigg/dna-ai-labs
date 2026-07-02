import test from "node:test";
import assert from "node:assert/strict";
import { PostgresReadAdapter } from "../src/postgres-read-adapter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

class QueryMock {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async query(sql, params = []) {
    this.calls.push({ sql, params });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response || { rows: [] };
  }
}

function projectRow() {
  return {
    id: "project-1", title: "Release evidence", stage: "Incubating", origin_team: "Developer Experience", target_users: "Release leads",
    potential_reach: 4, problem: "Evidence is fragmented.", metric: "Review duration", baseline: "3 hours", target: "1 hour",
    metric_source: "Release tracker", metric_owner_id: "user-1", sponsor_id: "user-2", receiving_owner_id: "user-3",
    project_lead_id: "user-1", risk_classification: "Internal", transfer_date: "2026-12-18", adoption_acknowledged_at: null,
    triage_status: "information_requested", information_requested_by: "user-2", information_requested_at: "2026-06-20T00:30:00.000Z",
    shared_platform_impact: false, extension_count: 0, created_at: "2026-06-20T00:00:00.000Z", created_by: "user-4", updated_at: "2026-06-20T01:00:00.000Z"
  };
}

test("PostgreSQL reads are tenant-scoped and serialize portfolio evidence, reviews, and decisions", async () => {
  const database = new QueryMock([
    { rows: [projectRow()] },
    { rows: [{ project_id: "project-1", gate_key: "metric_evidence", status: "complete", evidence_link: "https://docs.example/metric", completed_by: "user-1", completed_at: "2026-06-20T00:00:00.000Z", exception_reason: null }] },
    { rows: [{ id: "evidence-1", project_id: "project-1", evidence_type: "metric_result", result: "Faster", sample_size: 12, confidence: "high", source_link: "https://docs.example/metric", observed_at: "2026-06-19", created_by: "user-1", created_at: "2026-06-20T00:00:00.000Z" }] },
    { rows: [{ project_id: "project-1", review_type: "accessibility", status: "complete", evidence_link: "https://docs.example/a11y", completed_by: "user-1", completed_at: "2026-06-20T00:00:00.000Z", exception_reason: null }, { project_id: "project-1", review_type: "responsible_ai", status: "complete", evidence_link: "https://docs.example/rai", completed_by: "user-1", completed_at: "2026-06-20T00:00:00.000Z", exception_reason: null }] },
    { rows: [{ id: "decision-1", project_id: "project-1", outcome: "Scale", rationale: "Measured result", status: "requested", requested_by: "user-1", requested_at: "2026-06-20T00:00:00.000Z", finalized_by: null, finalized_at: null }] },
    { rows: [{ decision_id: "decision-1", approver_id: "user-2", approver_role: "lab-lead", result: "approved", comment: "Evidence reviewed", created_at: "2026-06-20T00:00:00.000Z" }] },
    { rows: [] }
  ]);
  const adapter = new PostgresReadAdapter({ queryable: database, organizationId: "org-a" });
  const [project] = await adapter.listProjects();

  assert.equal(project.evidence[0].sampleSize, 12);
  assert.equal(project.triageStatus, "information_requested");
  assert.equal(project.informationRequestedBy, "user-2");
  assert.equal(project.reviewsComplete, true);
  assert.deepEqual(project.pendingDecision.requiredApprovers, ["lab-lead", "executive-sponsor"]);
  assert.deepEqual(project.pendingDecision.missingGates, ["operating_owner", "capacity_plan", "reviews_complete"]);
  assert.equal(project.sponsor.name, undefined);
  assert.equal(database.calls.length, 7);
  for (const call of database.calls) {
    assert.match(call.sql, /organization_id = \$1/);
    assert.equal(call.params[0], "org-a");
  }
  assert.equal(database.calls.some(call => call.sql.includes("user-1")), false);
});

test("PostgreSQL triage comment reads are tenant and project scoped", async () => {
  const database = new QueryMock([
    { rows: [{ id: "comment-1", projectId: "project-1", authorId: "user-2", kind: "request_for_information", comment: "Clarify the pilot cohort.", createdAt: "2026-06-20T00:30:00.000Z" }] }
  ]);
  const adapter = new PostgresReadAdapter({ queryable: database, organizationId: "org-a" });
  const comments = await adapter.listTriageComments("project-1");

  assert.equal(comments[0].kind, "request_for_information");
  assert.deepEqual(database.calls[0].params, ["org-a", "project-1"]);
  assert.match(database.calls[0].sql, /project_triage_comments/);
  assert.match(database.calls[0].sql, /organization_id = \$1 AND project_id = \$2/);
});

test("PostgreSQL intake revision reads are tenant and project scoped", async () => {
  const database = new QueryMock([
    { rows: [{ id: "revision-1", projectId: "project-1", revisionNumber: 1, content: { title: "Submitted" }, submittedBy: "user-1", submittedAt: "2026-06-20T00:00:00.000Z" }] },
    { rows: [{ id: "revision-2", projectId: "project-1", revisionNumber: 2, content: { title: "Updated" }, submittedBy: "user-1", submittedAt: "2026-06-21T00:00:00.000Z" }] }
  ]);
  const adapter = new PostgresReadAdapter({ queryable: database, organizationId: "org-a" });

  assert.equal((await adapter.listIntakeRevisions("project-1"))[0].content.title, "Submitted");
  assert.equal((await adapter.getIntakeRevision("project-1", 2)).revisionNumber, 2);
  assert.deepEqual(database.calls[0].params, ["org-a", "project-1"]);
  assert.deepEqual(database.calls[1].params, ["org-a", "project-1", 2]);
  assert.match(database.calls[0].sql, /intake_revisions/);
  assert.match(database.calls[1].sql, /revision_number = \$3/);
});

test("PostgreSQL user and audit reads scope the verified subject and never leak database errors", async () => {
  const database = new QueryMock([
    { rows: [{ id: "user-1" }] },
    { rows: [{ id: "audit-1", actor_id: "user-1", action: "evidence_recorded", entity_type: "evidence", entity_id: "evidence-1", before_summary: null, after_summary: { confidence: "high" }, created_at: "2026-06-20T00:00:00.000Z" }] }
  ]);
  const adapter = new PostgresReadAdapter({ queryable: database, organizationId: "org-a" });
  assert.deepEqual(await adapter.getActorBySubject("oidc-subject", "lab-lead"), { id: "user-1", name: "Verified user", role: "lab-lead" });
  assert.equal((await adapter.listAuditEvents(1))[0].after.confidence, "high");
  assert.deepEqual(database.calls[0].params, ["org-a", "oidc-subject"]);
  assert.deepEqual(database.calls[1].params, ["org-a", 1]);

  const unavailable = new PostgresReadAdapter({ queryable: new QueryMock([new Error("connection secret")]), organizationId: "org-a" });
  await assert.rejects(() => unavailable.listAuditEvents(), error => error instanceof WorkflowError && error.code === "DATABASE_UNAVAILABLE" && !error.message.includes("secret"));
});

test("PostgreSQL draft reads are tenant and actor scoped", async () => {
  const database = new QueryMock([
    { rows: [{ id: "draft-1", status: "Draft", owner_id: "user-1", collaborator_ids: [], collaborators: [{ userId: "user-2", permission: "edit", addedAt: "2026-06-20T00:00:00.000Z", addedBy: "user-1" }], content: { title: "Draft" }, created_at: "2026-06-20T00:00:00.000Z", created_by: "user-1", updated_at: "2026-06-20T01:00:00.000Z", updated_by: "user-1" }] },
    { rows: [{ id: "draft-1", status: "Draft", owner_id: "user-1", collaborator_ids: [], collaborators: [{ userId: "user-2", permission: "edit", addedAt: "2026-06-20T00:00:00.000Z", addedBy: "user-1" }], content: { title: "Draft" }, created_at: "2026-06-20T00:00:00.000Z", created_by: "user-1", updated_at: "2026-06-20T01:00:00.000Z", updated_by: "user-1" }] }
  ]);
  const adapter = new PostgresReadAdapter({ queryable: database, organizationId: "org-a" });

  assert.equal((await adapter.listIntakeDrafts("user-2"))[0].ownerId, "user-1");
  const draft = await adapter.getIntakeDraft("draft-1");
  assert.equal(draft.content.title, "Draft");
  assert.deepEqual(draft.collaborators.map(collaborator => ({ userId: collaborator.userId, permission: collaborator.permission })), [{ userId: "user-2", permission: "edit" }]);
  assert.equal(database.calls[0].params[0], "org-a");
  assert.equal(database.calls[0].params[1], "user-2");
  assert.match(database.calls[0].sql, /intake_draft_collaborators/);
  assert.match(database.calls[0].sql, /d\.collaborator_ids \? \$2/);
  assert.deepEqual(database.calls[1].params, ["org-a", "draft-1"]);
});
