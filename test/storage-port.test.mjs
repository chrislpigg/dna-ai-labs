import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteLabsStorage } from "../src/labs-store.mjs";
import { assertStoragePort, storagePortMethods } from "../src/storage-port.mjs";
import { WorkflowService } from "../src/workflow-service.mjs";
import { WorkflowError, stages } from "../src/workflow-policy.mjs";

function createWorkflow() {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-port-"));
  const storage = new SqliteLabsStorage(join(directory, "labs.sqlite"));
  return {
    storage,
    workflow: new WorkflowService(storage),
    dispose: () => { storage.close(); rmSync(directory, { recursive: true, force: true }); }
  };
}

test("workflow service operates through the storage port and preserves durable audit events", () => {
  const { workflow, storage, dispose } = createWorkflow();
  try {
    assert.equal(storagePortMethods.includes("getActor"), true);
    assert.equal(storagePortMethods.includes("getProject"), true);
    assert.equal(storagePortMethods.includes("insertIntakeDraft"), true);
    assert.equal(storagePortMethods.includes("updateIntakeDraft"), true);
    assert.equal(storagePortMethods.includes("updateIntakeDraftStatus"), true);
    assert.equal(storagePortMethods.includes("insertIntakeDraftCollaborator"), true);
    assert.equal(storagePortMethods.includes("deleteIntakeDraftCollaborator"), true);
    assert.equal(storagePortMethods.includes("listTriageComments"), true);
    assert.equal(storagePortMethods.includes("insertTriageComment"), true);
    assert.equal(storagePortMethods.includes("updateProjectTriageStatus"), true);
    assert.equal(storagePortMethods.includes("listIntakeRevisions"), true);
    assert.equal(storagePortMethods.includes("getIntakeRevision"), true);
    assert.equal(storagePortMethods.includes("insertIntakeRevision"), true);
    assert.equal(storagePortMethods.includes("updateProjectIntakeContent"), true);
    assert.equal(storagePortMethods.includes("getDecision"), true);
    assert.equal(storagePortMethods.includes("appendAudit"), true);
    assert.equal(storagePortMethods.includes("transaction"), true);

    const project = workflow.createIntake(workflow.actor("submitter-1"), {
      title: "Storage port intake", originTeam: "Developer Experience", users: "Release leads", potentialReach: 3,
      problem: "Release evidence is fragmented.", metric: "Review duration", baseline: "3 hours", target: "1 hour", metricSource: "Release tracker",
      metricOwnerId: "accessibility-lead", sponsorId: "executive-sponsor", receivingOwnerId: "receiving-owner", projectLeadId: "accessibility-lead",
      riskClassification: "Internal", transferDate: "2026-12-18", adoptionGate: true, evidenceGate: true
    });
    assert.equal(project.stage, stages.SUBMITTED);
    assert.equal(workflow.auditEvents(workflow.actor("lab-lead")).some(event => event.entityId === project.id && event.action === "intake_submitted"), true);
    assert.equal(workflow.listProjects().some(item => item.id === project.id), true);
  } finally { dispose(); }
});

test("storage adapters fail fast when they do not meet the persistence contract", () => {
  assert.throws(() => assertStoragePort({}), error => error instanceof TypeError && error.message.includes("getActor"));
  assert.throws(() => new WorkflowService({}), error => error instanceof TypeError);
  assert.equal(WorkflowError.name, "WorkflowError");
});
