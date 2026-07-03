import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabsStore } from "../src/labs-store.mjs";
import { WorkflowError, outcomes, stages } from "../src/workflow-policy.mjs";

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-e2e-"));
  const store = new LabsStore(join(directory, "labs.sqlite"));
  return { store, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function intakeContent(title) {
  return {
    title,
    originTeam: "Developer Experience",
    users: "Release leads",
    potentialReach: 6,
    problem: "Release governance depends on manual readiness checks.",
    metric: "Readiness review time",
    baseline: "4 hours",
    target: "1 hour",
    metricSource: "Release tracker",
    metricOwnerId: "accessibility-lead",
    sponsorId: "executive-sponsor",
    receivingOwnerId: "receiving-owner",
    projectLeadId: "accessibility-lead",
    riskClassification: "Internal",
    transferDate: "2099-12-01",
    sharedPlatformImpact: true,
    adoptionGate: true,
    evidenceGate: true
  };
}

function approveAllRequired(store, decision) {
  store.approveDecision(store.actor("lab-lead"), decision.id, { result: "approved", comment: "Portfolio gate approved." });
  store.approveDecision(store.actor("executive-sponsor"), decision.id, { result: "approved", comment: "Sponsor approved." });
  store.approveDecision(store.actor("platform-reviewer"), decision.id, { result: "approved", comment: "Shared platform review approved." });
}

function completeTransferReadiness(store, projectId) {
  const lead = store.actor("accessibility-lead");
  store.addEvidence(lead, projectId, {
    evidenceType: "metric_result",
    result: "Readiness review time fell from 4 hours to 55 minutes.",
    sampleSize: 14,
    confidence: "high",
    sourceLink: "https://intranet.example/metrics/readiness",
    observedAt: "2026-07-01"
  });
  for (const reviewType of ["accessibility", "responsible_ai"]) {
    store.setReview(store.actor("platform-reviewer"), projectId, reviewType, { status: "complete", evidenceLink: `https://intranet.example/reviews/${reviewType}` });
  }
  for (const itemKey of ["architecture", "evaluation", "operating_model", "onboarding", "support", "cost", "monitoring", "rollback"]) {
    store.upsertDeliveryKitItem(lead, projectId, itemKey, { status: "complete", ownerId: "accessibility-lead", evidenceLink: `https://intranet.example/delivery/${itemKey}` });
  }
}

test("local governed workflow substitute runs draft through transfer with independent approvals and 30-day follow-up", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const receivingOwner = store.actor("receiving-owner");
    const labLead = store.actor("lab-lead");
    const admin = store.actor("admin");

    const draft = store.createIntakeDraft(submitter, { content: intakeContent("Governed transfer e2e") });
    assert.equal(draft.status, stages.DRAFT);

    const submitted = store.submitIntakeDraft(submitter, draft.id);
    assert.equal(submitted.stage, stages.SUBMITTED);
    assert.equal(store.intakeDraft(submitter, draft.id).status, stages.SUBMITTED);

    assert.equal(store.acknowledgeAdoption(receivingOwner, submitted.id).adoptionAcknowledged, true);
    assert.equal(store.selectProject(labLead, submitted.id).stage, stages.SELECTED);
    assert.equal(store.startIncubation(labLead, submitted.id).stage, stages.INCUBATING);

    const decision = store.requestDecision(store.actor("accessibility-lead"), submitted.id, {
      outcome: outcomes.TRANSFER,
      rationale: "Pilot results are ready for the receiving owner with a completed delivery kit."
    });
    assert.equal(store.project(submitted.id).stage, stages.DECISION_PENDING);
    approveAllRequired(store, decision);

    store.acceptHandoff(receivingOwner, submitted.id, {
      adoptionPlanLink: "https://intranet.example/adoption/transfer-e2e",
      supportEndDate: "2099-12-01",
      followUpDate: "2099-12-31",
      onboardingAcknowledged: true
    });
    completeTransferReadiness(store, submitted.id);

    const finalized = store.finalizeDecision(labLead, decision.id);
    assert.equal(finalized.project.stage, stages.TRANSFERRED);
    assert.equal(finalized.decision.status, "finalized");
    assert.equal(finalized.project.handoff.status, "accepted");
    assert.equal(finalized.project.followUp.dueOn, "2099-12-31");
    assert.equal(finalized.project.followUp.status, "pending");
    assert.equal(store.notificationOutbox(admin).some(notification => notification.notificationType === "follow_up_due" && notification.availableAt === "2099-12-31T09:00:00.000Z"), true);

    const actions = new Set(store.auditEvents(admin, 200).map(event => event.action));
    for (const action of ["intake_draft_submitted", "adoption_acknowledged", "decision_requested", "handoff_accepted", "follow_up_created", "decision_finalized"]) {
      assert.equal(actions.has(action), true);
    }
  } finally { dispose(); }
});

test("local governed workflow substitute covers rejection and revised decision request path", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const receivingOwner = store.actor("receiving-owner");
    const labLead = store.actor("lab-lead");
    const executive = store.actor("executive-sponsor");

    const draft = store.createIntakeDraft(submitter, { content: intakeContent("Governed rejection e2e") });
    const project = store.submitIntakeDraft(submitter, draft.id);
    store.acknowledgeAdoption(receivingOwner, project.id);
    store.selectProject(labLead, project.id);
    store.startIncubation(labLead, project.id);

    const first = store.requestDecision(store.actor("accessibility-lead"), project.id, {
      outcome: outcomes.SCALE,
      rationale: "Initial recommendation based on early readiness results."
    });
    assert.equal(store.project(project.id).stage, stages.DECISION_PENDING);
    const rejected = store.approveDecision(executive, first.id, { result: "rejected", comment: "Need a broader pilot cohort." });
    assert.equal(rejected.status, "rejected");
    assert.equal(store.project(project.id).stage, stages.INCUBATING);

    const revised = store.requestDecision(store.actor("accessibility-lead"), project.id, {
      outcome: outcomes.SCALE,
      rationale: "Revised recommendation after broadening the pilot cohort."
    });
    assert.notEqual(revised.id, first.id);
    assert.equal(store.auditEvents(labLead, 100).some(event => event.action === "decision_rejected" && event.entityId === first.id), true);
  } finally { dispose(); }
});
