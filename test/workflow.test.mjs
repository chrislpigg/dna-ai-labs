import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabsStore } from "../src/labs-store.mjs";
import { WorkflowError, outcomes, stages } from "../src/workflow-policy.mjs";
import { DirectoryAdapter } from "../src/directory-adapter.mjs";
import { ArtifactVerifier } from "../src/artifact-verifier.mjs";
import { WorkTrackingAdapter } from "../src/work-tracking-adapter.mjs";
import { CalendarAdapter } from "../src/calendar-adapter.mjs";
import { AnalyticsAdapter } from "../src/analytics-adapter.mjs";

function createStore(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-"));
  const store = new LabsStore(join(directory, "labs.sqlite"), options);
  return { store, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function expectWorkflowError(fn, code) {
  assert.throws(fn, error => error instanceof WorkflowError && error.code === code);
}

const validIntake = {
  title: "Release readiness assistant",
  originTeam: "Developer Experience",
  users: "Release leads",
  potentialReach: 5,
  problem: "Release leads repeat a manual readiness review.",
  metric: "Review time",
  baseline: "3 hours",
  target: "1 hour",
  metricSource: "Release tracker",
  metricOwnerId: "accessibility-lead",
  sponsorId: "executive-sponsor",
  receivingOwnerId: "receiving-owner",
  projectLeadId: "accessibility-lead",
  riskClassification: "Internal",
  transferDate: "2026-12-18",
  adoptionGate: true,
  evidenceGate: true
};

function testDirectory(overrides = {}) {
  const people = ["accessibility-lead", "executive-sponsor", "receiving-owner", "inactive-owner"].map(id => ({
    id, displayName: `Directory ${id}`, organization: "Verified Org", managerId: "admin", active: id !== "inactive-owner",
    employeeNumber: "not-stored", email: `${id}@example.invalid`, ...(overrides[id] || {})
  })).filter(person => overrides[person.id] !== null);
  return new DirectoryAdapter({
    lookupPersonSync: id => overrides[id] === null ? null : ({
      id, displayName: `Directory ${id}`, organization: "Verified Org", managerId: "admin", active: true,
      employeeNumber: "not-stored", email: `${id}@example.invalid`, ...(overrides[id] || {})
    }),
    lookupPerson: async id => overrides[id] === null ? null : ({
      id, displayName: `Directory ${id}`, organization: "Verified Org", managerId: "admin", active: true, ...(overrides[id] || {})
    }),
    searchPeople: async query => people.filter(person => !query || person.id.includes(query) || person.displayName.includes(query))
  });
}

test("an intake needs meaningful evidence and adoption inputs", () => {
  const { store, dispose } = createStore();
  try {
    const actor = store.actor("submitter-1");
    expectWorkflowError(() => store.createIntake(actor, { title: " ", potentialReach: 0 }), "INVALID_INTAKE");
    expectWorkflowError(() => store.createIntake(actor, { ...validIntake, receivingOwnerId: "" }), "INVALID_INTAKE");
    const project = store.createIntake(actor, validIntake);
    assert.equal(project.stage, stages.SUBMITTED);
    assert.equal(store.auditEvents(store.actor("lab-lead")).some(event => event.action === "intake_submitted"), true);
  } finally { dispose(); }
});

test("intake owner assignments are validated through the company directory without persisting raw directory fields", () => {
  const inactive = createStore({ directoryAdapter: testDirectory({ "receiving-owner": { active: false } }) });
  try {
    expectWorkflowError(() => inactive.store.createIntake(inactive.store.actor("submitter-1"), validIntake), "DIRECTORY_PERSON_INACTIVE");
  } finally { inactive.dispose(); }

  const unknown = createStore({ directoryAdapter: testDirectory({ "executive-sponsor": null }) });
  try {
    expectWorkflowError(() => unknown.store.createIntake(unknown.store.actor("submitter-1"), validIntake), "DIRECTORY_PERSON_NOT_FOUND");
  } finally { unknown.dispose(); }

  const { store, dispose } = createStore({ directoryAdapter: testDirectory() });
  try {
    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    assert.equal(project.sponsor.id, "executive-sponsor");
    assert.equal(Object.hasOwn(project.sponsor, "email"), false);
    assert.equal(Object.hasOwn(project.sponsor, "employeeNumber"), false);
  } finally { dispose(); }
});

test("directory people search is role-gated and exposes only approved person metadata", async () => {
  const { store, dispose } = createStore({ directoryAdapter: testDirectory() });
  try {
    await assert.rejects(
      () => store.searchDirectoryPeople(store.actor("receiving-owner"), "owner"),
      error => error instanceof WorkflowError && error.code === "FORBIDDEN"
    );

    const people = await store.searchDirectoryPeople(store.actor("submitter-1"), "Directory");
    assert.deepEqual(people.map(person => person.id), ["accessibility-lead", "executive-sponsor", "receiving-owner"]);
    assert.deepEqual(Object.keys(people[0]).sort(), ["active", "displayName", "id", "managerId", "organization"]);
    assert.equal(Object.hasOwn(people[0], "email"), false);
    assert.equal(Object.hasOwn(people[0], "employeeNumber"), false);
  } finally { dispose(); }
});

test("project reads include directory organization context and warn on stale or inactive assignments", () => {
  const { store, dispose } = createStore({
    directoryAdapter: testDirectory({
      "receiving-owner": { active: false, organization: "Customer Operations", managerId: "manager-1", verifiedAt: "2026-01-01T00:00:00.000Z" }
    })
  });
  try {
    const project = store.project("accessibility-agent");
    assert.equal(project.receivingOwner.directory.organization, "Customer Operations");
    assert.equal(project.receivingOwner.directory.managerId, "manager-1");
    assert.equal(project.receivingOwner.directory.active, false);
    assert.equal(project.directoryAssignments.receivingOwner.stale, true);
    assert.equal(Object.hasOwn(project.receivingOwner.directory, "email"), false);
    assert.equal(Object.hasOwn(project.receivingOwner.directory, "employeeNumber"), false);
    assert.deepEqual(
      project.directoryWarnings.filter(warning => warning.userId === "receiving-owner").map(warning => warning.code).sort(),
      ["DIRECTORY_CONTEXT_STALE", "DIRECTORY_PERSON_INACTIVE"]
    );
    store.acknowledgeAdoption(store.actor("receiving-owner"), project.id);
    expectWorkflowError(() => store.selectProject(store.actor("lab-lead"), project.id), "RECEIVING_OWNER_INACTIVE");
  } finally { dispose(); }
});

test("intake drafts can be saved incomplete and are visible only to owners and draft collaborators", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const draft = store.createIntakeDraft(submitter, {
      content: { title: "  Draft release assistant  ", problem: "Still being scoped.", potentialReach: 0 }
    });

    assert.equal(draft.status, stages.DRAFT);
    assert.equal(draft.ownerId, "submitter-1");
    assert.equal(draft.content.title, "Draft release assistant");
    assert.deepEqual(draft.collaborators, []);
    assert.equal(store.listProjects().some(project => project.id === draft.id), false);
    assert.equal(store.listIntakeDrafts(submitter).some(item => item.id === draft.id), true);
    expectWorkflowError(() => store.intakeDraft(store.actor("lab-lead"), draft.id), "FORBIDDEN");

    const shared = store.addIntakeDraftCollaborator(submitter, draft.id, { userId: "accessibility-lead", permission: "edit" });
    assert.deepEqual(shared.collaborators.map(collaborator => ({ userId: collaborator.userId, permission: collaborator.permission })), [{ userId: "accessibility-lead", permission: "edit" }]);
    assert.equal(store.intakeDraft(store.actor("accessibility-lead"), draft.id).id, draft.id);

    const updated = store.updateIntakeDraft(store.actor("accessibility-lead"), draft.id, { content: { metric: "Cycle time" } });
    assert.equal(updated.content.metric, "Cycle time");
    expectWorkflowError(() => store.addIntakeDraftCollaborator(store.actor("accessibility-lead"), draft.id, { userId: "lab-lead", permission: "edit" }), "FORBIDDEN");
    expectWorkflowError(() => store.updateIntakeDraft(store.actor("accessibility-lead"), draft.id, { ownerId: "accessibility-lead" }), "FORBIDDEN");
    expectWorkflowError(() => store.updateIntakeDraft(store.actor("accessibility-lead"), draft.id, { status: stages.SUBMITTED }), "FORBIDDEN");
    expectWorkflowError(() => store.updateIntakeDraft(submitter, draft.id, { collaboratorIds: ["lab-lead"] }), "COLLABORATOR_ENDPOINT_REQUIRED");

    const removed = store.removeIntakeDraftCollaborator(submitter, draft.id, "accessibility-lead");
    assert.deepEqual(removed.collaborators, []);
    expectWorkflowError(() => store.intakeDraft(store.actor("accessibility-lead"), draft.id), "FORBIDDEN");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_draft_created"), true);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_draft_updated"), true);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_draft_collaborator_added"), true);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_draft_collaborator_removed"), true);
  } finally { dispose(); }
});

test("draft submission is owner-only, validates selection data, and audits the transition", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const incomplete = store.createIntakeDraft(submitter, { content: { title: "Incomplete intake" } });
    expectWorkflowError(() => store.submitIntakeDraft(submitter, incomplete.id), "INVALID_INTAKE");
    assert.equal(store.intakeDraft(submitter, incomplete.id).status, stages.DRAFT);

    const shared = store.createIntakeDraft(submitter, { content: validIntake });
    store.addIntakeDraftCollaborator(submitter, shared.id, { userId: "accessibility-lead", permission: "edit" });
    expectWorkflowError(() => store.submitIntakeDraft(store.actor("accessibility-lead"), shared.id), "FORBIDDEN");

    const project = store.submitIntakeDraft(submitter, shared.id);
    assert.equal(project.stage, stages.SUBMITTED);
    assert.equal(project.createdBy, "submitter-1");
    assert.equal(store.intakeDraft(submitter, shared.id).status, stages.SUBMITTED);
    expectWorkflowError(() => store.updateIntakeDraft(submitter, shared.id, { content: { title: "Changed after submit" } }), "INVALID_STATE");
    expectWorkflowError(() => store.submitIntakeDraft(submitter, shared.id), "INVALID_STATE");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_draft_submitted" && event.entityId === shared.id), true);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_submitted" && event.after.draftId === shared.id), true);
  } finally { dispose(); }
});

test("intake resubmission creates immutable revisions and reviewers can compare changed fields", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const labLead = store.actor("lab-lead");
    const project = store.createIntake(submitter, validIntake);
    const original = store.listIntakeRevisions(labLead, project.id);
    assert.equal(original.length, 1);
    assert.equal(original[0].revisionNumber, 1);
    assert.equal(original[0].content.title, "Release readiness assistant");
    assert.equal(original[0].content.potentialReach, 5);

    store.requestTriageInformation(labLead, project.id, { comment: "Clarify the pilot scope." });
    expectWorkflowError(() => store.resubmitIntake(labLead, project.id, { ...validIntake, target: "45 minutes" }), "FORBIDDEN");
    const result = store.resubmitIntake(submitter, project.id, { ...validIntake, target: "45 minutes", potentialReach: 7 });
    assert.equal(result.revision.revisionNumber, 2);
    assert.equal(result.project.target, "45 minutes");
    assert.equal(result.project.potentialReach, 7);
    assert.equal(result.project.triageStatus, "open");

    const revisions = store.listIntakeRevisions(labLead, project.id);
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].content.target, "1 hour");
    assert.equal(revisions[1].content.target, "45 minutes");
    expectWorkflowError(() => store.compareIntakeRevisions(store.actor("employee-1"), project.id, 1, 2), "FORBIDDEN");

    const comparison = store.compareIntakeRevisions(labLead, project.id, 1, 2);
    assert.deepEqual(comparison.changes.map(change => change.field), ["potentialReach", "target"]);
    assert.deepEqual(comparison.changes.find(change => change.field === "target"), { field: "target", before: "1 hour", after: "45 minutes" });
    expectWorkflowError(() => store.compareIntakeRevisions(labLead, project.id, 1, 99), "REVISION_NOT_FOUND");

    store.acknowledgeAdoption(store.actor("receiving-owner"), project.id);
    store.selectProject(labLead, project.id);
    expectWorkflowError(() => store.resubmitIntake(submitter, project.id, validIntake), "INVALID_STATE");
  } finally { dispose(); }
});

test("submitted or triaged intakes can be withdrawn only by their owner before selection", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const project = store.createIntake(submitter, validIntake);
    expectWorkflowError(() => store.withdrawIntake(store.actor("lab-lead"), project.id), "FORBIDDEN");

    const withdrawn = store.withdrawIntake(submitter, project.id);
    assert.equal(withdrawn.deletionReason, "withdrawn");
    assert.equal(store.listProjects().some(item => item.id === project.id), false);
    expectWorkflowError(() => store.project(project.id), "NOT_FOUND");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "intake_withdrawn" && event.entityId === project.id), true);

    const selected = store.createIntake(submitter, { ...validIntake, title: "Selected intake" });
    store.acknowledgeAdoption(store.actor("receiving-owner"), selected.id);
    store.selectProject(store.actor("lab-lead"), selected.id);
    expectWorkflowError(() => store.withdrawIntake(submitter, selected.id), "INVALID_STATE");
  } finally { dispose(); }
});

test("triage comments are chronological, participant-scoped, and RFI does not advance selection", () => {
  const { store, dispose } = createStore();
  try {
    const submitter = store.actor("submitter-1");
    const labLead = store.actor("lab-lead");
    const project = store.createIntake(submitter, validIntake);

    expectWorkflowError(() => store.listTriageComments(store.actor("employee-1"), project.id), "FORBIDDEN");
    expectWorkflowError(() => store.addTriageComment(store.actor("employee-1"), project.id, { comment: "Unassigned comment" }), "FORBIDDEN");
    expectWorkflowError(() => store.requestTriageInformation(submitter, project.id, { comment: "Need more detail" }), "FORBIDDEN");

    const first = store.addTriageComment(submitter, project.id, { comment: "Initial context is ready for triage." });
    assert.equal(first.length, 1);
    assert.equal(first[0].authorId, "submitter-1");
    assert.equal(first[0].kind, "comment");
    assert.equal(store.listTriageComments(store.actor("accessibility-lead"), project.id)[0].comment, "Initial context is ready for triage.");

    const result = store.requestTriageInformation(labLead, project.id, { comment: "Please clarify the pilot user cohort." });
    assert.equal(result.project.stage, stages.SUBMITTED);
    assert.equal(result.project.triageStatus, "information_requested");
    assert.equal(result.comments.map(comment => comment.kind).join(","), "comment,request_for_information");
    assert.equal(store.project(project.id).informationRequestedBy, "lab-lead");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "triage_comment_added"), true);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "triage_information_requested"), true);

    store.acknowledgeAdoption(store.actor("receiving-owner"), project.id);
    store.selectProject(labLead, project.id);
    expectWorkflowError(() => store.addTriageComment(labLead, project.id, { comment: "Too late for triage." }), "INVALID_STATE");
  } finally { dispose(); }
});

test("administrators can create and update governed program cycles", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    expectWorkflowError(() => store.createCycle(store.actor("lab-lead"), {
      name: "Unauthorized cycle", theme: "Quality", startsOn: "2026-10-01", endsOn: "2026-12-31", capacityUnits: 3, steeringGroupIds: ["lab-lead"], status: "planned"
    }), "FORBIDDEN");
    expectWorkflowError(() => store.createCycle(admin, {
      name: "Bad dates", theme: "Quality", startsOn: "2026-12-31", endsOn: "2026-10-01", capacityUnits: 3, steeringGroupIds: ["lab-lead"], status: "planned"
    }), "INVALID_CYCLE_DATES");
    expectWorkflowError(() => store.createCycle(admin, {
      name: "Bad capacity", theme: "Quality", startsOn: "2026-10-01", endsOn: "2026-12-31", capacityUnits: 0, steeringGroupIds: ["lab-lead"], status: "planned"
    }), "INVALID_CYCLE_CAPACITY");

    const cycle = store.createCycle(admin, {
      name: "Cycle 02 · 2026", theme: "Operational readiness", startsOn: "2026-10-01", endsOn: "2026-12-31", capacityUnits: 4, steeringGroupIds: ["lab-lead", "executive-sponsor"], status: "planned"
    });
    assert.equal(cycle.capacityUnits, 4);
    assert.deepEqual(cycle.steeringGroupIds, ["lab-lead", "executive-sponsor"]);
    const updated = store.updateCycle(admin, cycle.id, { capacityUnits: 5, status: "active", steeringGroupIds: ["lab-lead"] });
    assert.equal(updated.theme, "Operational readiness");
    assert.equal(updated.capacityUnits, 5);
    assert.equal(updated.status, "active");
    assert.deepEqual(updated.steeringGroupIds, ["lab-lead"]);
    assert.equal(store.listCycles().some(item => item.id === cycle.id), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "cycle_created" && event.entityId === cycle.id), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "cycle_updated" && event.entityId === cycle.id), true);
  } finally { dispose(); }
});

test("delivery-kit items are required, owner-assigned, approved-link backed, and audited", () => {
  const { store, dispose } = createStore();
  try {
    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    const lead = store.actor("accessibility-lead");
    const labLead = store.actor("lab-lead");

    const defaults = store.listDeliveryKit(labLead, project.id);
    assert.deepEqual(defaults.map(item => item.itemKey), ["architecture", "evaluation", "operating_model", "onboarding", "support", "cost", "monitoring", "rollback"]);
    assert.equal(defaults.every(item => item.status === "not_started"), true);
    expectWorkflowError(() => store.upsertDeliveryKitItem(store.actor("receiving-owner"), project.id, "architecture", { status: "in_progress", ownerId: "accessibility-lead" }), "FORBIDDEN");
    expectWorkflowError(() => store.upsertDeliveryKitItem(lead, project.id, "unknown", { status: "in_progress", ownerId: "accessibility-lead" }), "INVALID_DELIVERY_KIT_ITEM");
    expectWorkflowError(() => store.upsertDeliveryKitItem(lead, project.id, "architecture", { status: "complete", ownerId: "accessibility-lead" }), "MISSING_DELIVERY_KIT_EVIDENCE");
    expectWorkflowError(() => store.upsertDeliveryKitItem(lead, project.id, "architecture", { status: "complete", ownerId: "accessibility-lead", evidenceLink: "https://external.example/architecture" }), "UNAPPROVED_EVIDENCE_LINK");

    const item = store.upsertDeliveryKitItem(lead, project.id, "architecture", {
      status: "complete",
      ownerId: "accessibility-lead",
      evidenceLink: "https://intranet.example/architecture"
    });
    assert.equal(item.status, "complete");
    assert.equal(item.acceptedBy, "accessibility-lead");
    assert.equal(store.project(project.id).deliveryKit.find(entry => entry.itemKey === "architecture").evidenceLink, "https://intranet.example/architecture");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "delivery_kit_item_updated" && event.entityId === `${project.id}:architecture`), true);

    const reset = store.deleteDeliveryKitItem(labLead, project.id, "architecture");
    assert.equal(reset.status, "not_started");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "delivery_kit_item_deleted" && event.entityId === `${project.id}:architecture`), true);
  } finally { dispose(); }
});

test("delivery-kit gate exceptions are audited for transfer readiness", () => {
  const { store, dispose } = createStore();
  try {
    const labLead = store.actor("lab-lead");
    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    store.setGate(labLead, project.id, "delivery_kit", { status: "excepted", exceptionReason: "Receiving team accepted support boundary risk for pilot transfer." });
    const pending = store.project(project.id).gates.find(gate => gate.key === "delivery_kit");
    assert.equal(pending.status, "excepted");
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "delivery_kit_exception_accepted" && event.entityId === `${project.id}:delivery_kit`), true);
  } finally { dispose(); }
});

test("work tracking is feature-gated, provider-verified, refreshed, and audited", () => {
  let providerFails = true;
  const workTrackingAdapter = new WorkTrackingAdapter({
    approvedOrigins: ["https://tracker.example"],
    linkWorkItemSync: ({ externalUrl }) => {
      if (providerFails) throw new Error("tracker unavailable");
      return {
        provider: "tracker",
        externalRef: "WORK-123",
        externalUrl,
        externalStatus: "in_progress",
        lastVerifiedAt: "2026-07-02T00:00:00.000Z"
      };
    },
    refreshWorkItemSync: ({ item }) => ({
      provider: item.provider,
      externalRef: item.externalRef,
      externalUrl: item.externalUrl,
      externalStatus: "done",
      lastVerifiedAt: "2026-07-02T01:00:00.000Z"
    })
  });
  const { store, dispose } = createStore({ workTrackingAdapter });
  try {
    const admin = store.actor("admin");
    const lead = store.actor("accessibility-lead");
    const project = store.createIntake(store.actor("submitter-1"), validIntake);

    expectWorkflowError(() => store.createOrLinkWorkItem(lead, project.id, { externalUrl: "https://tracker.example/browse/WORK-123" }), "FEATURE_DISABLED");
    store.setFeatureFlag(admin, "work_tracking_integration", { enabled: true });
    expectWorkflowError(() => store.createOrLinkWorkItem(store.actor("receiving-owner"), project.id, { externalUrl: "https://tracker.example/browse/WORK-123" }), "FORBIDDEN");
    expectWorkflowError(() => store.createOrLinkWorkItem(lead, project.id, { externalUrl: "https://external.example/browse/WORK-123" }), "UNAPPROVED_WORK_ITEM_LINK");
    expectWorkflowError(() => store.createOrLinkWorkItem(lead, project.id, { externalUrl: "https://tracker.example/browse/WORK-123" }), "WORK_TRACKING_UNAVAILABLE");
    assert.equal(store.project(project.id).workItem, null);

    providerFails = false;
    const linked = store.createOrLinkWorkItem(lead, project.id, { externalUrl: "https://tracker.example/browse/WORK-123" });
    assert.equal(linked.externalStatus, "in_progress");
    assert.equal(linked.lastVerifiedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(store.project(project.id).workItem.externalRef, "WORK-123");

    const refreshed = store.refreshWorkItem(lead, project.id);
    assert.equal(refreshed.externalStatus, "done");
    assert.equal(refreshed.lastVerifiedAt, "2026-07-02T01:00:00.000Z");
    assert.equal(store.auditEvents(admin).some(event => event.action === "work_item_created" && event.entityId === project.id), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "work_item_refreshed" && event.entityId === project.id), true);
  } finally { dispose(); }
});

test("metric plans store approved source references and preserve verified data on refresh failure", () => {
  let providerFails = false;
  const analyticsAdapter = new AnalyticsAdapter({
    refreshMetricSync: ({ plan }) => {
      if (providerFails) throw new Error("provider secret raw metric payload");
      return {
        value: "42 active teams",
        verifiedAt: "2026-07-02T00:00:00.000Z",
        staleAt: "2026-08-01T00:00:00.000Z",
        sourceRef: plan.sourceRef
      };
    }
  });
  const { store, dispose } = createStore({ analyticsAdapter });
  try {
    const admin = store.actor("admin");
    const lead = store.actor("accessibility-lead");
    const project = store.createIntake(store.actor("submitter-1"), validIntake);

    expectWorkflowError(() => store.upsertMetricPlan(store.actor("receiving-owner"), project.id, {
      sourceType: "analytics_dashboard",
      sourceRef: "dashboards/adoption-readiness",
      hypothesisLabel: "Expected review time reduction"
    }), "FORBIDDEN");
    expectWorkflowError(() => store.upsertMetricPlan(lead, project.id, {
      sourceType: "freeform",
      sourceRef: "dashboards/adoption-readiness",
      hypothesisLabel: "Expected review time reduction"
    }), "INVALID_METRIC_SOURCE_TYPE");

    const plan = store.upsertMetricPlan(lead, project.id, {
      sourceType: "analytics_dashboard",
      sourceRef: "dashboards/adoption-readiness",
      hypothesisLabel: "Expected review time reduction"
    });
    assert.equal(plan.refreshStatus, "hypothesis");
    assert.equal(plan.sourceRef, "dashboards/adoption-readiness");
    assert.equal(store.project(project.id).metricPlan.hypothesisLabel, "Expected review time reduction");

    const refreshed = store.refreshMetricPlan(lead, project.id);
    assert.equal(refreshed.refreshStatus, "verified");
    assert.equal(refreshed.verifiedValue, "42 active teams");
    assert.equal(refreshed.verifiedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(refreshed.staleAt, "2026-08-01T00:00:00.000Z");

    providerFails = true;
    const stale = store.refreshMetricPlan(lead, project.id);
    assert.equal(stale.refreshStatus, "stale");
    assert.equal(stale.verifiedValue, "42 active teams");
    assert.equal(stale.verifiedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(stale.lastErrorCode, "ANALYTICS_UNAVAILABLE");
    assert.equal(JSON.stringify(stale).includes("provider secret"), false);
    assert.equal(store.auditEvents(admin).some(event => event.action === "metric_plan_created" && event.entityId === `${project.id}:primary`), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "metric_refreshed" && event.entityId === `${project.id}:primary`), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "metric_refresh_failed" && event.entityId === `${project.id}:primary`), true);
  } finally { dispose(); }
});

test("calendar events are feature-gated, provider-verified, and audited", () => {
  let providerFails = true;
  const calendarAdapter = new CalendarAdapter({
    approvedOrigins: ["https://calendar.example"],
    validateEventSync: ({ eventType, scheduledFor, externalUrl }) => {
      if (providerFails) throw new Error("calendar unavailable");
      return {
        provider: "calendar",
        externalRef: "event-decision",
        externalUrl,
        scheduledFor,
        lastVerifiedAt: "2026-07-02T00:00:00.000Z",
        eventType
      };
    },
    createEventSync: ({ eventType, scheduledFor }) => ({
      provider: "calendar",
      externalRef: "event-follow-up",
      externalUrl: "https://calendar.example/events/follow-up",
      scheduledFor,
      lastVerifiedAt: "2026-07-02T01:00:00.000Z",
      eventType
    })
  });
  const { store, dispose } = createStore({ calendarAdapter });
  try {
    const admin = store.actor("admin");
    const lead = store.actor("accessibility-lead");
    const labLead = store.actor("lab-lead");
    const project = store.createIntake(store.actor("submitter-1"), validIntake);

    expectWorkflowError(() => store.scheduleCalendarEvent(labLead, project.id, { eventType: "decision_meeting", scheduledFor: "2026-07-10T16:00:00.000Z" }), "FEATURE_DISABLED");
    store.setFeatureFlag(admin, "calendar_integration", { enabled: true });
    expectWorkflowError(() => store.scheduleCalendarEvent(labLead, project.id, { eventType: "decision_meeting", scheduledFor: "2026-07-10T16:00:00.000Z" }), "DECISION_EVENT_REQUIRED");

    store.acknowledgeAdoption(store.actor("receiving-owner"), project.id);
    store.selectProject(labLead, project.id);
    store.startIncubation(labLead, project.id);
    store.requestDecision(lead, project.id, { outcome: outcomes.SCALE, rationale: "Schedule decision review." });
    expectWorkflowError(() => store.scheduleCalendarEvent(labLead, project.id, { eventType: "decision_meeting", scheduledFor: "2026-07-10T16:00:00.000Z", externalUrl: "https://external.example/events/decision" }), "UNAPPROVED_CALENDAR_EVENT_LINK");
    expectWorkflowError(() => store.scheduleCalendarEvent(labLead, project.id, { eventType: "decision_meeting", scheduledFor: "2026-07-10T16:00:00.000Z", externalUrl: "https://calendar.example/events/decision" }), "CALENDAR_UNAVAILABLE");
    assert.equal(store.project(project.id).calendarEvents.length, 0);

    providerFails = false;
    const meeting = store.scheduleCalendarEvent(labLead, project.id, { eventType: "decision_meeting", scheduledFor: "2026-07-10T16:00:00.000Z", externalUrl: "https://calendar.example/events/decision" });
    assert.equal(meeting.eventType, "decision_meeting");
    assert.equal(meeting.externalRef, "event-decision");

    store.acknowledgeAdoption(store.actor("receiving-owner"), "accessibility-agent");
    const transferProject = store.selectProject(labLead, "accessibility-agent");
    store.startIncubation(labLead, transferProject.id);
    store.requestDecision(lead, transferProject.id, { outcome: outcomes.TRANSFER, rationale: "Schedule receiving-owner follow-up." });
    store.acceptHandoff(store.actor("receiving-owner"), transferProject.id, {
      adoptionPlanLink: "https://intranet.example/adoption",
      supportEndDate: "2026-12-18",
      followUpDate: "2026-08-01",
      onboardingAcknowledged: true
    });
    const followUp = store.scheduleCalendarEvent(store.actor("receiving-owner"), transferProject.id, { eventType: "follow_up" });
    assert.equal(followUp.eventType, "follow_up");
    assert.equal(followUp.scheduledFor, "2026-08-01");
    assert.equal(store.project(transferProject.id).calendarEvents.some(event => event.eventType === "follow_up"), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "calendar_event_scheduled" && event.entityId === `${project.id}:decision_meeting:${store.project(project.id).pendingDecision.id}`), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "calendar_event_scheduled" && event.entityId === `${transferProject.id}:follow_up`), true);
  } finally { dispose(); }
});

test("workflow mutations create transactional notification outbox entries without sensitive payloads", () => {
  const calendarAdapter = new CalendarAdapter({
    approvedOrigins: ["https://calendar.example"],
    createEventSync: ({ eventType, scheduledFor }) => ({
      provider: "calendar",
      externalRef: `event-${eventType}`,
      externalUrl: `https://calendar.example/events/${eventType}`,
      scheduledFor,
      lastVerifiedAt: "2026-07-02T02:00:00.000Z",
      eventType
    })
  });
  const { store, dispose } = createStore({ calendarAdapter });
  try {
    const admin = store.actor("admin");
    const labLead = store.actor("lab-lead");
    const lead = store.actor("accessibility-lead");
    const receivingOwner = store.actor("receiving-owner");
    expectWorkflowError(() => store.notificationOutbox(labLead), "FORBIDDEN");

    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    store.acknowledgeAdoption(receivingOwner, project.id);
    store.selectProject(labLead, project.id);
    store.startIncubation(labLead, project.id);
    store.setReview(store.actor("platform-reviewer"), project.id, "accessibility", { status: "complete", evidenceLink: "https://intranet.example/accessibility-review" });
    store.requestDecision(lead, project.id, { outcome: outcomes.TRANSFER, rationale: "Pilot users reduced review time and the receiving team is ready." });
    store.acceptHandoff(receivingOwner, project.id, {
      adoptionPlanLink: "https://intranet.example/adoption",
      supportEndDate: "2026-12-18",
      followUpDate: "2026-08-01",
      onboardingAcknowledged: true
    });
    store.setFeatureFlag(admin, "calendar_integration", { enabled: true });
    store.scheduleCalendarEvent(receivingOwner, project.id, { eventType: "follow_up" });

    const outbox = store.notificationOutbox(admin);
    const types = new Set(outbox.map(notification => notification.notificationType));
    for (const type of ["intake_submitted", "adoption_acknowledged", "review_updated", "decision_requested", "handoff_accepted", "follow_up_scheduled"]) {
      assert.equal(types.has(type), true);
    }
    assert.equal(outbox.every(notification => notification.state === "pending"), true);
    assert.equal(outbox.every(notification => notification.attemptCount === 0), true);
    assert.equal(outbox.some(notification => notification.recipientId === "lab-lead" && notification.notificationType === "intake_submitted"), true);
    assert.equal(outbox.some(notification => notification.recipientId === "accessibility-lead" && notification.notificationType === "handoff_accepted"), true);
    assert.equal(outbox.some(notification => notification.relatedEntityType === "decision" && notification.payload.projectId === project.id), true);

    const serialized = JSON.stringify(outbox);
    for (const forbidden of [
      validIntake.title,
      validIntake.problem,
      "Pilot users reduced review time",
      "https://intranet.example",
      "calendar.example"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally { dispose(); }
});

test("notification outbox writes roll back with their business mutation", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    const beforeCount = store.notificationOutbox(admin).length;
    const original = store.storage.insertNotificationOutbox.bind(store.storage);
    store.storage.insertNotificationOutbox = () => { throw new Error("outbox unavailable"); };
    assert.throws(() => store.createIntake(store.actor("submitter-1"), { ...validIntake, title: "Rollback notification intake" }), /outbox unavailable/);
    store.storage.insertNotificationOutbox = original;

    assert.equal(store.notificationOutbox(admin).length, beforeCount);
    assert.equal(store.listProjects().some(project => project.title === "Rollback notification intake"), false);
    assert.equal(store.auditEvents(admin).some(event => event.after?.title === "Rollback notification intake"), false);
  } finally { dispose(); }
});

test("handoff acceptance creates a tracked follow-up and scheduled reminder", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    const labLead = store.actor("lab-lead");
    const lead = store.actor("accessibility-lead");
    const receivingOwner = store.actor("receiving-owner");
    store.acknowledgeAdoption(receivingOwner, "accessibility-agent");
    const selected = store.selectProject(labLead, "accessibility-agent");
    store.startIncubation(labLead, selected.id);
    store.requestDecision(lead, selected.id, { outcome: outcomes.TRANSFER, rationale: "Schedule adoption follow-up." });
    store.acceptHandoff(receivingOwner, selected.id, {
      adoptionPlanLink: "https://intranet.example/adoption",
      supportEndDate: "2026-12-18",
      followUpDate: "2026-08-01",
      onboardingAcknowledged: true
    });

    const project = store.project(selected.id);
    assert.equal(project.followUp.projectId, selected.id);
    assert.equal(project.followUp.dueOn, "2026-08-01");
    assert.equal(project.followUp.status, "pending");
    assert.equal(project.followUp.derivedStatus, "pending");

    const reminder = store.notificationOutbox(admin).find(notification => notification.notificationType === "follow_up_due" && notification.relatedEntityId === selected.id);
    assert.ok(reminder);
    assert.equal(reminder.recipientId, "receiving-owner");
    assert.equal(reminder.relatedEntityType, "project_follow_up");
    assert.equal(reminder.availableAt, "2026-08-01T09:00:00.000Z");
    assert.deepEqual(reminder.payload, { projectId: selected.id, dueOn: "2026-08-01" });
    assert.equal(store.auditEvents(admin).some(event => event.action === "follow_up_created" && event.entityId === selected.id), true);

    store.storage.db.prepare("UPDATE project_follow_ups SET due_on = ? WHERE project_id = ?").run("2020-01-01", selected.id);
    const overdue = store.project(selected.id).followUp;
    assert.equal(overdue.status, "pending");
    assert.equal(overdue.derivedStatus, "overdue");
    assert.equal(overdue.completedAt, null);
  } finally { dispose(); }
});

test("integration health is admin-only and excludes sensitive provider payloads", () => {
  const workTrackingAdapter = new WorkTrackingAdapter({
    approvedOrigins: ["https://tracker.example"],
    linkWorkItemSync: () => { throw new Error("provider token secret"); }
  });
  const { store, dispose } = createStore({ workTrackingAdapter });
  try {
    const admin = store.actor("admin");
    const lead = store.actor("accessibility-lead");
    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    store.setFeatureFlag(admin, "work_tracking_integration", { enabled: true });
    expectWorkflowError(() => store.createOrLinkWorkItem(lead, project.id, { externalUrl: "https://tracker.example/browse/SECRET-1" }), "WORK_TRACKING_UNAVAILABLE");

    expectWorkflowError(() => store.integrationHealth(store.actor("lab-lead")), "FORBIDDEN");
    const health = store.integrationHealth(admin);
    const work = health.summary.find(entry => entry.integrationType === "work_tracking");
    assert.equal(work.recentFailures, 1);
    assert.equal(work.lastOutcome, "failure");
    assert.equal(work.lastErrorCode, "WORK_TRACKING_UNAVAILABLE");
    assert.equal(health.attempts[0].integrationType, "work_tracking");
    assert.equal(health.attempts[0].projectId, project.id);
    const serialized = JSON.stringify(health);
    assert.equal(serialized.includes("SECRET-1"), false);
    assert.equal(serialized.includes("tracker.example"), false);
    assert.equal(serialized.includes("provider token secret"), false);
  } finally { dispose(); }
});

test("Fellow assignments require manager acknowledgement before activation", () => {
  const { store, dispose } = createStore();
  try {
    const labLead = store.actor("lab-lead");
    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    expectWorkflowError(() => store.createFellowAssignment(store.actor("submitter-1"), {
      cycleId: project.cycleId, projectId: project.id, fellowId: "employee-1", assignmentRole: "Pilot builder", capacityUnits: 1
    }), "FORBIDDEN");
    expectWorkflowError(() => store.createFellowAssignment(labLead, {
      cycleId: project.cycleId, projectId: project.id, fellowId: "employee-1", assignmentRole: "Pilot builder", capacityUnits: 1, status: "active"
    }), "MANAGER_ACK_REQUIRED");

    const assignment = store.createFellowAssignment(labLead, {
      cycleId: project.cycleId, projectId: project.id, fellowId: "employee-1", assignmentRole: "Pilot builder", capacityUnits: 1
    });
    assert.equal(assignment.status, "proposed");
    assert.equal(assignment.managerId, "admin");
    expectWorkflowError(() => store.updateFellowAssignment(labLead, assignment.id, { status: "active" }), "MANAGER_ACK_REQUIRED");
    expectWorkflowError(() => store.acknowledgeFellowAssignment(store.actor("lab-lead"), assignment.id), "FORBIDDEN");

    const active = store.acknowledgeFellowAssignment(store.actor("admin"), assignment.id);
    assert.equal(active.status, "active");
    assert.equal(active.managerAcknowledgedBy, "admin");
    assert.equal(store.updateFellowAssignment(labLead, assignment.id, { status: "completed", outcome: "Reusable workflow documented" }).status, "completed");
    expectWorkflowError(() => store.acknowledgeFellowAssignment(store.actor("admin"), assignment.id), "INVALID_FELLOW_ASSIGNMENT_STATE");
    assert.equal(store.listFellowAssignments(labLead, { projectId: project.id }).length, 1);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "fellow_assignment_created"), true);
    assert.equal(store.auditEvents(store.actor("admin")).some(event => event.action === "fellow_assignment_acknowledged"), true);
  } finally { dispose(); }
});

test("selection cannot exceed the cycle's approved capacity", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    const labLead = store.actor("lab-lead");
    const cycle = store.createCycle(admin, {
      name: "Small cycle", theme: "Focused pilot", startsOn: "2026-10-01", endsOn: "2026-12-31", capacityUnits: 1, steeringGroupIds: ["lab-lead"], status: "planned"
    });
    const first = store.createIntake(store.actor("submitter-1"), { ...validIntake, cycleId: cycle.id, title: "First selected intake" });
    const second = store.createIntake(store.actor("submitter-1"), { ...validIntake, cycleId: cycle.id, title: "Second selected intake" });
    store.acknowledgeAdoption(store.actor("receiving-owner"), first.id);
    store.acknowledgeAdoption(store.actor("receiving-owner"), second.id);
    assert.equal(store.selectProject(labLead, first.id).stage, stages.SELECTED);

    assert.throws(
      () => store.selectProject(labLead, second.id),
      error => error instanceof WorkflowError
        && error.code === "CYCLE_CAPACITY_EXCEEDED"
        && error.details.cycleId === cycle.id
        && error.details.remainingCapacity === 0
        && error.details.capacityUnits === 1
    );
  } finally { dispose(); }
});

test("feature flags are admin-controlled and enforced by protected workflow features", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    const submitter = store.actor("submitter-1");
    const project = store.createIntake(submitter, validIntake);
    assert.equal(store.listFeatureFlags(admin).find(flag => flag.key === "intake_resubmission").enabled, true);
    expectWorkflowError(() => store.listFeatureFlags(store.actor("lab-lead")), "FORBIDDEN");
    expectWorkflowError(() => store.setFeatureFlag(store.actor("lab-lead"), "intake_resubmission", { enabled: false }), "FORBIDDEN");
    expectWorkflowError(() => store.setFeatureFlag(admin, "unknown_flag", { enabled: false }), "UNKNOWN_FEATURE_FLAG");

    const disabled = store.setFeatureFlag(admin, "intake_resubmission", { enabled: false });
    assert.equal(disabled.enabled, false);
    expectWorkflowError(() => store.resubmitIntake(submitter, project.id, { ...validIntake, target: "45 minutes" }), "FEATURE_DISABLED");
    const enabled = store.setFeatureFlag(admin, "intake_resubmission", { enabled: true });
    assert.equal(enabled.enabled, true);
    assert.equal(store.resubmitIntake(submitter, project.id, { ...validIntake, target: "45 minutes" }).revision.revisionNumber, 2);
    assert.equal(store.auditEvents(admin).some(event => event.action === "feature_flag_updated" && event.entityId === "intake_resubmission"), true);
  } finally { dispose(); }
});

test("role assignments are admin-only, audited, and block self-escalation", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    expectWorkflowError(() => store.listRoleAssignments(store.actor("lab-lead")), "FORBIDDEN");
    expectWorkflowError(() => store.setRoleAssignment(store.actor("lab-lead"), "employee-1", { role: "submitter" }), "FORBIDDEN");
    expectWorkflowError(() => store.setRoleAssignment(admin, "employee-1", { role: "not-a-role" }), "INVALID_ROLE");
    expectWorkflowError(() => store.setRoleAssignment(admin, "admin", { role: "lab-lead" }), "SELF_ROLE_ESCALATION");

    const assignment = store.setRoleAssignment(admin, "employee-1", { role: "submitter" });
    assert.equal(assignment.role, "submitter");
    assert.equal(assignment.active, true);
    assert.equal(store.actor("employee-1").role, "submitter");
    const disabled = store.setRoleAssignment(admin, "employee-1", { role: "submitter", active: false });
    assert.equal(disabled.active, false);
    assert.equal(store.actor("employee-1").role, "employee");
    assert.equal(store.listRoleAssignments(admin).some(item => item.userId === "employee-1"), true);
    assert.equal(store.auditEvents(admin).some(event => event.action === "role_assignment_updated" && event.entityId === "employee-1"), true);
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
    expectWorkflowError(() => store.setGate(labLead, project.id, "reviews_complete", { status: "complete", evidenceLink: "https://intranet.example/reviews" }), "REVIEW_RECORD_REQUIRED");
    for (const reviewType of ["accessibility", "responsible_ai"]) store.setReview(store.actor("platform-reviewer"), project.id, reviewType, { status: "complete", evidenceLink: `https://intranet.example/${reviewType}` });
    expectWorkflowError(() => store.setGate(labLead, project.id, "receiving_owner_ack", { status: "complete", evidenceLink: "https://intranet.example/ack" }), "HANDOFF_REQUIRED");
    expectWorkflowError(() => store.acceptHandoff(lead, project.id, { adoptionPlanLink: "https://intranet.example/adoption", supportEndDate: "2026-12-18", followUpDate: "2026-12-20", onboardingAcknowledged: true }), "FORBIDDEN");
    store.acceptHandoff(store.actor("receiving-owner"), project.id, { adoptionPlanLink: "https://intranet.example/adoption", supportEndDate: "2026-12-18", followUpDate: "2026-12-20", onboardingAcknowledged: true });
    assert.throws(
      () => store.finalizeDecision(labLead, decision.id),
      error => error instanceof WorkflowError
        && error.code === "MISSING_GATES"
        && error.details.missingGates.includes("delivery_kit:architecture")
        && error.details.missingGates.includes("delivery_kit:rollback")
    );
    for (const itemKey of ["architecture", "evaluation", "operating_model", "onboarding", "support", "cost", "monitoring", "rollback"]) {
      store.upsertDeliveryKitItem(lead, project.id, itemKey, { status: "complete", ownerId: "accessibility-lead", evidenceLink: `https://intranet.example/delivery-${itemKey}` });
    }
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

test("failed artifact verification never completes evidence-backed gates", () => {
  let providerResult = { status: "failed", reasonCode: "not_found" };
  const artifactVerifier = new ArtifactVerifier({
    approvedOrigins: ["https://intranet.example"],
    verifyRecordSync: () => providerResult
  });
  const { store, dispose } = createStore({ artifactVerifier });
  try {
    const labLead = store.actor("lab-lead");
    const lead = store.actor("accessibility-lead");
    store.acknowledgeAdoption(store.actor("receiving-owner"), "accessibility-agent");
    store.selectProject(labLead, "accessibility-agent");
    store.startIncubation(labLead, "accessibility-agent");

    expectWorkflowError(() => store.addEvidence(lead, "accessibility-agent", {
      evidenceType: "metric_result",
      result: "Metric improved",
      sampleSize: 5,
      confidence: "medium",
      sourceLink: "https://intranet.example/metric",
      observedAt: "2026-06-19"
    }), "ARTIFACT_VERIFICATION_FAILED");
    assert.notEqual(store.project("accessibility-agent").gates.find(gate => gate.key === "metric_evidence")?.status, "complete");

    providerResult = { status: "verified", verifiedAt: "2026-07-02T00:00:00.000Z", method: "record_validation" };
    const project = store.addEvidence(lead, "accessibility-agent", {
      evidenceType: "metric_result",
      result: "Metric improved",
      sampleSize: 5,
      confidence: "medium",
      sourceLink: "https://intranet.example/metric",
      observedAt: "2026-06-19"
    });
    assert.equal(project.evidence[0].artifactVerificationStatus, "verified");
    assert.equal(project.evidence[0].artifactVerificationMethod, "record_validation");
    assert.equal(project.gates.find(gate => gate.key === "metric_evidence").artifactVerificationStatus, "verified");
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

test("only administrators can soft-delete and restore a project, with durable audit history", () => {
  const { store, dispose } = createStore();
  try {
    const admin = store.actor("admin");
    expectWorkflowError(() => store.deleteProject(store.actor("lab-lead"), "accessibility-agent", "duplicate"), "FORBIDDEN");
    expectWorkflowError(() => store.deleteProject(admin, "accessibility-agent", "free-form-sensitive-content"), "INVALID_DELETION_REASON");

    store.deleteProject(admin, "accessibility-agent", "duplicate");
    assert.equal(store.listProjects().some(project => project.id === "accessibility-agent"), false);
    expectWorkflowError(() => store.project("accessibility-agent"), "NOT_FOUND");
    assert.equal(store.auditEvents(admin).some(event => event.action === "project_deleted"), true);

    const restored = store.restoreProject(admin, "accessibility-agent");
    assert.equal(restored.id, "accessibility-agent");
    assert.equal(store.auditEvents(admin).some(event => event.action === "project_restored"), true);
  } finally { dispose(); }
});

test("an unexpired retained final decision blocks ordinary project deletion", () => {
  const { store, dispose } = createStore();
  try {
    store.storage.db.prepare("INSERT INTO decisions (id, project_id, outcome, rationale, status, requested_by, requested_at, finalized_by, finalized_at, retention_classification, retention_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("retained-decision", "accessibility-agent", "Sunset", "Decision metadata", "finalized", "admin", "2026-01-01T00:00:00.000Z", "admin", "2026-01-01T00:00:00.000Z", "program_record", "2033-01-01T00:00:00.000Z");
    expectWorkflowError(() => store.deleteProject(store.actor("admin"), "accessibility-agent", "duplicate"), "RETENTION_ACTIVE");
    const audit = store.storage.db.prepare("SELECT retention_classification, retention_until FROM audit_events LIMIT 1").get();
    assert.equal(audit.retention_classification, "program_record");
    assert.match(audit.retention_until, /^20\d\d-/);
  } finally { dispose(); }
});

test("audit integrity verification detects an altered durable audit record", () => {
  const { store, dispose } = createStore();
  try {
    assert.equal(store.verifyAuditIntegrity().valid, true);
    store.storage.db.prepare("UPDATE audit_events SET action = ? WHERE audit_sequence = 1").run("altered_after_write");
    assert.deepEqual(store.verifyAuditIntegrity(), { valid: false, checked: 0, issue: "audit_hash_mismatch" });
  } finally { dispose(); }
});
