import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioMetrics } from "../src/portfolio-metrics.mjs";
import { outcomes, stages } from "../src/workflow-policy.mjs";

const cycles = [
  { id: "cycle-a", name: "Cycle A", theme: "Operational readiness" },
  { id: "cycle-b", name: "Cycle B", theme: "Engineering quality" }
];

const baseProject = {
  title: "Project",
  createdBy: "submitter-1",
  metricOwnerId: "metric-owner",
  sponsor: { id: "sponsor" },
  receivingOwner: { id: "receiving-owner" },
  projectLead: { id: "lead" },
  potentialReach: 1,
  baseline: "baseline",
  target: "target",
  metricSource: "tracker",
  decisionHistory: [],
  pendingDecision: null,
  directoryWarnings: [],
  followUp: null
};

function project(patch) {
  return { ...baseProject, ...patch };
}

test("portfolio metrics count filtered lifecycle, impact, and risk states", () => {
  const metrics = buildPortfolioMetrics({
    cycles,
    projects: [
      project({ id: "candidate", title: "Candidate", cycleId: "cycle-a", stage: stages.SUBMITTED, riskClassification: "Internal", potentialReach: 3 }),
      project({ id: "active", title: "Active", cycleId: "cycle-a", stage: stages.INCUBATING, riskClassification: "Internal", potentialReach: 5, metricPlan: { refreshStatus: "verified", verifiedValue: "5 teams", sourceRef: "https://analytics.example/metrics/active", verifiedAt: "2026-07-02T00:00:00.000Z" } }),
      project({ id: "pending", title: "Pending", cycleId: "cycle-a", stage: stages.DECISION_PENDING, riskClassification: "Confidential business", pendingDecision: { outcome: outcomes.TRANSFER, missingGates: ["delivery_kit"] }, potentialReach: 7 }),
      project({ id: "adopter", title: "Adopter", cycleId: "cycle-b", stage: stages.TRANSFERRED, riskClassification: "Internal", handoff: { status: "accepted" }, potentialReach: 9, metricPlan: { refreshStatus: "stale", hypothesisLabel: "Expected adoption", sourceRef: "dashboard/adoption", verifiedAt: "2026-06-01T00:00:00.000Z" } })
    ],
    filters: { cycleId: "cycle-a", theme: "readiness" }
  });

  assert.deepEqual(metrics.counts, {
    candidate: 1,
    active: 1,
    decisionPending: 1,
    validatedAdopter: 0,
    validatedImpact: 1,
    atRisk: 1
  });
  assert.equal(metrics.impact.potentialReach, 15);
  assert.equal(metrics.impact.validatedReach, 5);
  assert.equal(metrics.projects.map(item => item.id).join(","), "candidate,active,pending");
  assert.equal(metrics.metricSources.find(source => source.projectId === "active").sourceHref, "https://analytics.example/metrics/active");
});

test("portfolio metrics filter by owner, risk, outcome, stage, and labels hypotheses", () => {
  const metrics = buildPortfolioMetrics({
    cycles,
    projects: [
      project({ id: "scale", title: "Scale", cycleId: "cycle-a", stage: stages.DECISION_PENDING, riskClassification: "Restricted metadata", projectLead: { id: "lead-a" }, pendingDecision: { outcome: outcomes.SCALE, missingGates: [] } }),
      project({ id: "transfer", title: "Transfer", cycleId: "cycle-a", stage: stages.INCUBATING, riskClassification: "Internal", projectLead: { id: "lead-b" }, pendingDecision: { outcome: outcomes.TRANSFER, missingGates: [] } })
    ],
    filters: { ownerId: "lead-a", risk: "Restricted metadata", outcome: outcomes.SCALE, stage: stages.DECISION_PENDING }
  });

  assert.deepEqual(metrics.projects.map(item => item.id), ["scale"]);
  assert.equal(metrics.counts.decisionPending, 1);
  assert.equal(metrics.metricSources[0].status, "hypothesis");
  assert.equal(metrics.metricSources[0].sourceHref, null);
  assert.equal(metrics.metricSources[0].sourceLabel, "tracker");
  assert.deepEqual(metrics.availableFilters.outcomes.sort(), [outcomes.SCALE, outcomes.TRANSFER].sort());
});
