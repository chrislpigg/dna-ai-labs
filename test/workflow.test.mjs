import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabsStore } from "../src/labs-store.mjs";
import { WorkflowError, outcomes, stages } from "../src/workflow-policy.mjs";

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-"));
  const store = new LabsStore(join(directory, "labs.sqlite"));
  return { store, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function expectWorkflowError(fn, code) {
  assert.throws(fn, error => error instanceof WorkflowError && error.code === code);
}

test("an intake needs meaningful evidence and adoption inputs", () => {
  const { store, dispose } = createStore();
  try {
    const actor = store.actor("submitter-1");
    expectWorkflowError(() => store.createIntake(actor, { title: " ", potentialReach: 0 }), "INVALID_INTAKE");
    const project = store.createIntake(actor, {
      title: "Release readiness assistant", originTeam: "Developer Experience", users: "Release leads", potentialReach: 5,
      problem: "Release leads repeat a manual readiness review.", metric: "Review time", baseline: "3 hours", target: "1 hour", metricSource: "Release tracker", metricOwnerId: "accessibility-lead",
      sponsorId: "executive-sponsor", receivingOwnerId: "receiving-owner", projectLeadId: "accessibility-lead", riskClassification: "Internal", transferDate: "2026-12-18", adoptionGate: true, evidenceGate: true
    });
    assert.equal(project.stage, stages.SUBMITTED);
    assert.equal(store.auditEvents(store.actor("lab-lead")).some(event => event.action === "intake_submitted"), true);
  } finally { dispose(); }
});

test("only Lab leadership can select and start an incubation", () => {
  const { store, dispose } = createStore();
  try {
    const intake = store.createIntake(store.actor("submitter-1"), {
      title: "Quality assistant", originTeam: "Quality", users: "Engineers", potentialReach: 3, problem: "Reviews take too long.", metric: "Review time", baseline: "3 hours", target: "1 hour", metricSource: "Tracker", metricOwnerId: "accessibility-lead", sponsorId: "executive-sponsor", receivingOwnerId: "receiving-owner", projectLeadId: "accessibility-lead", riskClassification: "Internal", transferDate: "2026-12-18", adoptionGate: true, evidenceGate: true
    });
    expectWorkflowError(() => store.selectProject(store.actor("submitter-1"), intake.id), "FORBIDDEN");
    expectWorkflowError(() => store.selectProject(store.actor("lab-lead"), intake.id), "MISSING_ADOPTION_ACK");
    expectWorkflowError(() => store.acknowledgeAdoption(store.actor("accessibility-lead"), intake.id), "FORBIDDEN");
    assert.equal(store.acknowledgeAdoption(store.actor("receiving-owner"), intake.id).adoptionAcknowledged, true);
    assert.equal(store.selectProject(store.actor("lab-lead"), intake.id).stage, stages.SELECTED);
    assert.equal(store.startIncubation(store.actor("lab-lead"), intake.id).stage, stages.INCUBATING);
  } finally { dispose(); }
});

test("a transfer cannot finalize until all gates and independent approvals exist", () => {
  const { store, dispose } = createStore();
  try {
    const lead = store.actor("accessibility-lead");
    const labLead = store.actor("lab-lead");
    const executive = store.actor("executive-sponsor");
    store.acknowledgeAdoption(store.actor("receiving-owner"), "accessibility-agent");
    const project = store.selectProject(labLead, "accessibility-agent");
    store.startIncubation(labLead, project.id);
    const decision = store.requestDecision(lead, project.id, { outcome: outcomes.TRANSFER, rationale: "Pilot users reduced review time and the receiving team is ready." });
    expectWorkflowError(() => store.approveDecision(lead, decision.id, { result: "approved", comment: "I approve." }), "SELF_APPROVAL");
    store.approveDecision(labLead, decision.id, { result: "approved", comment: "Portfolio gate approved." });
    store.approveDecision(executive, decision.id, { result: "approved", comment: "Sponsor approves transfer." });
    expectWorkflowError(() => store.finalizeDecision(labLead, decision.id), "MISSING_APPROVALS");
    store.approveDecision(store.actor("platform-reviewer"), decision.id, { result: "approved", comment: "Shared pattern is aligned." });
    expectWorkflowError(() => store.finalizeDecision(labLead, decision.id), "MISSING_GATES");
    expectWorkflowError(() => store.setGate(labLead, project.id, "metric_evidence", { status: "complete", evidenceLink: "https://intranet.example/metric" }), "EVIDENCE_ENTRY_REQUIRED");
    expectWorkflowError(() => store.addEvidence(lead, project.id, { evidenceType: "metric_result", result: "Review time reduced", sampleSize: 0, confidence: "high", sourceLink: "https://intranet.example/metric", observedAt: "2026-06-19" }), "INVALID_SAMPLE_SIZE");
    store.addEvidence(lead, project.id, { evidenceType: "metric_result", result: "Review time reduced from 4 hours to 2 hours", sampleSize: 12, confidence: "high", sourceLink: "https://intranet.example/metric", observedAt: "2026-06-19" });
    store.setGate(labLead, project.id, "delivery_kit", { status: "complete", evidenceLink: "https://intranet.example/delivery-kit" });
    expectWorkflowError(() => store.setGate(labLead, project.id, "reviews_complete", { status: "complete", evidenceLink: "https://intranet.example/reviews" }), "REVIEW_RECORD_REQUIRED");
    for (const reviewType of ["accessibility", "responsible_ai"]) store.setReview(store.actor("platform-reviewer"), project.id, reviewType, { status: "complete", evidenceLink: `https://intranet.example/${reviewType}` });
    expectWorkflowError(() => store.setGate(labLead, project.id, "receiving_owner_ack", { status: "complete", evidenceLink: "https://intranet.example/ack" }), "HANDOFF_REQUIRED");
    expectWorkflowError(() => store.acceptHandoff(lead, project.id, { adoptionPlanLink: "https://intranet.example/adoption", supportEndDate: "2026-12-18", followUpDate: "2026-12-20", onboardingAcknowledged: true }), "FORBIDDEN");
    store.acceptHandoff(store.actor("receiving-owner"), project.id, { adoptionPlanLink: "https://intranet.example/adoption", supportEndDate: "2026-12-18", followUpDate: "2026-12-20", onboardingAcknowledged: true });
    const result = store.finalizeDecision(labLead, decision.id);
    assert.equal(result.project.stage, stages.TRANSFERRED);
    assert.equal(result.decision.status, "finalized");
    assert.equal(result.project.handoff.status, "accepted");
    assert.equal(store.auditEvents(store.actor("lab-lead")).some(event => event.action === "decision_finalized"), true);
  } finally { dispose(); }
});

test("a project can extend only once", () => {
    const { store, dispose } = createStore();
    try {
    const labLead = store.actor("lab-lead");
    const executive = store.actor("executive-sponsor");
    store.acknowledgeAdoption(store.actor("receiving-owner"), "accessibility-agent");
    const project = store.selectProject(labLead, "accessibility-agent");
    store.startIncubation(labLead, project.id);
    store.addEvidence(store.actor("accessibility-lead"), project.id, { evidenceType: "metric_result", result: "Pilot result recorded", sampleSize: 8, confidence: "medium", sourceLink: "https://intranet.example/metric", observedAt: "2026-06-19" });
    for (const key of ["revised_scope", "sponsor_approval"]) store.setGate(labLead, project.id, key, { status: "complete", evidenceLink: `https://intranet.example/${key}` });
    const first = store.requestDecision(store.actor("accessibility-lead"), project.id, { outcome: outcomes.EXTEND, rationale: "Need one bounded cycle to validate adoption." });
    store.approveDecision(labLead, first.id, { result: "approved", comment: "One extension approved." });
    store.approveDecision(executive, first.id, { result: "approved", comment: "Sponsor agrees." });
    store.approveDecision(store.actor("platform-reviewer"), first.id, { result: "approved", comment: "Platform reviewer agrees." });
    store.finalizeDecision(labLead, first.id);
    expectWorkflowError(() => store.requestDecision(store.actor("accessibility-lead"), project.id, { outcome: outcomes.EXTEND, rationale: "Second extension." }), "EXTENSION_LIMIT");
  } finally { dispose(); }
});

test("gate evidence is restricted to approved internal origins", () => {
  const { store, dispose } = createStore();
  try {
    expectWorkflowError(() => store.setGate(store.actor("lab-lead"), "accessibility-agent", "delivery_kit", { status: "complete", evidenceLink: "https://unapproved.example/evidence" }), "UNAPPROVED_EVIDENCE_LINK");
    const project = store.setGate(store.actor("lab-lead"), "accessibility-agent", "delivery_kit", { status: "complete", evidenceLink: "https://intranet.example/evidence" });
    assert.equal(project.gates.find(gate => gate.key === "delivery_kit").status, "complete");
  } finally { dispose(); }
});

test("audit events are restricted to governance roles", () => {
  const { store, dispose } = createStore();
  try {
    expectWorkflowError(() => store.auditEvents(store.actor("submitter-1")), "FORBIDDEN");
    assert.ok(store.auditEvents(store.actor("executive-sponsor")).length > 0);
  } finally { dispose(); }
});

test("confidential work requires security and privacy reviews before its review gate completes", () => {
  const { store, dispose } = createStore();
  try {
    const intake = store.createIntake(store.actor("submitter-1"), {
      title: "Confidential workflow assistant", originTeam: "Operations", users: "Operations leads", potentialReach: 2,
      problem: "A recurring confidential workflow is manual.", metric: "Completion time", baseline: "5 hours", target: "2 hours", metricSource: "Operations report", metricOwnerId: "accessibility-lead",
      sponsorId: "executive-sponsor", receivingOwnerId: "receiving-owner", projectLeadId: "accessibility-lead", riskClassification: "Confidential business", transferDate: "2026-12-18", adoptionGate: true, evidenceGate: true
    });
    const labLead = store.actor("lab-lead");
    store.acknowledgeAdoption(store.actor("receiving-owner"), intake.id);
    store.selectProject(labLead, intake.id);
    store.startIncubation(labLead, intake.id);
    for (const type of ["accessibility", "responsible_ai"]) store.setReview(store.actor("platform-reviewer"), intake.id, type, { status: "complete", evidenceLink: `https://intranet.example/${type}` });
    assert.equal(store.project(intake.id).reviewsComplete, false);
    for (const type of ["security", "privacy"]) store.setReview(store.actor("platform-reviewer"), intake.id, type, { status: "complete", evidenceLink: `https://intranet.example/${type}` });
    assert.equal(store.project(intake.id).reviewsComplete, true);
  } finally { dispose(); }
});

test("a rejected decision returns the project to incubation and permits a revised request", () => {
  const { store, dispose } = createStore();
  try {
    const labLead = store.actor("lab-lead");
    store.acknowledgeAdoption(store.actor("receiving-owner"), "accessibility-agent");
    store.selectProject(labLead, "accessibility-agent");
    store.startIncubation(labLead, "accessibility-agent");
    const decision = store.requestDecision(store.actor("accessibility-lead"), "accessibility-agent", { outcome: outcomes.SCALE, rationale: "Initial recommendation." });
    const rejected = store.approveDecision(store.actor("executive-sponsor"), decision.id, { result: "rejected", comment: "Need a broader pilot cohort." });
    assert.equal(rejected.status, "rejected");
    assert.equal(store.project("accessibility-agent").stage, stages.INCUBATING);
    const revised = store.requestDecision(store.actor("accessibility-lead"), "accessibility-agent", { outcome: outcomes.SCALE, rationale: "Revised recommendation with broader cohort." });
    assert.equal(revised.status, "requested");
    assert.equal(store.auditEvents(labLead).some(event => event.action === "decision_rejected"), true);
  } finally { dispose(); }
});
