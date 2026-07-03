import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabsStore } from "../src/labs-store.mjs";
import { Observability, sanitizeTelemetry } from "../src/observability.mjs";
import { stages } from "../src/workflow-policy.mjs";

const validIntake = {
  title: "Telemetry-safe project",
  originTeam: "Developer Experience",
  users: "Release leads",
  potentialReach: 3,
  problem: "Repeated manual release checks.",
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

function createStore(observability) {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-observability-"));
  const store = new LabsStore(join(directory, "labs.sqlite"), { observability });
  return { store, dispose: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("telemetry redaction removes tokens, payloads, narrative content, and links", () => {
  const sanitized = sanitizeTelemetry({
    authorization: "Bearer token-secret",
    cookie: "session=secret",
    actorId: "user-1",
    payload: { title: "Should not appear" },
    after: { rationale: "raw decision text", evidenceLink: "https://intranet.example/doc" },
    details: { errorCode: "SAFE_CODE" }
  });

  assert.equal(sanitized.authorization, "[redacted]");
  assert.equal(sanitized.cookie, "[redacted]");
  assert.equal(sanitized.payload, "[redacted]");
  assert.equal(sanitized.after.rationale, "[redacted]");
  assert.equal(sanitized.after.evidenceLink, "[redacted]");
  assert.equal(sanitized.actorId, "user-1");
  assert.equal(sanitized.details.errorCode, "SAFE_CODE");
});

test("observability emits structured events and metric counters", () => {
  const records = [];
  const observability = new Observability({ logger: { log: line => records.push(JSON.parse(line)) } });
  observability.withContext({ correlationId: "corr-12345678" }, () => {
    observability.request({ method: "POST", route: "/api/v1/intakes", statusCode: 201, actorId: "submitter-1" });
    observability.security({ code: "CSRF_TOKEN_INVALID", statusCode: 403, token: "secret" });
  });

  assert.equal(records[0].event, "request");
  assert.equal(records[0].correlationId, "corr-12345678");
  assert.equal(records[1].token, "[redacted]");
  assert.deepEqual(
    observability.snapshot().counters.map(counter => ({ name: counter.name, count: counter.count })).sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "http_requests_total", count: 1 }, { name: "security_events_total", count: 1 }]
  );
});

test("workflow integration telemetry inherits request correlation without storing raw links", () => {
  const records = [];
  const observability = new Observability({ logger: { log: line => records.push(JSON.parse(line)) } });
  const { store, dispose } = createStore(observability);
  try {
    const project = store.createIntake(store.actor("submitter-1"), validIntake);
    store.acknowledgeAdoption(store.actor("receiving-owner"), project.id);
    store.selectProject(store.actor("lab-lead"), project.id);
    store.startIncubation(store.actor("lab-lead"), project.id);

    observability.withContext({ correlationId: "corr-integration-1" }, () => {
      store.addEvidence(store.actor("accessibility-lead"), project.id, {
        evidenceType: "metric_result",
        result: "Review time fell to one hour.",
        sampleSize: 5,
        confidence: "high",
        sourceLink: "https://intranet.example/measurements/release",
        observedAt: "2026-07-01"
      });
    });

    const integration = records.find(record => record.event === "integration");
    assert.equal(integration.correlationId, "corr-integration-1");
    assert.equal(integration.integrationType, "artifact");
    assert.equal(integration.outcome, "success");
    assert.equal(JSON.stringify(integration).includes("measurements/release"), false);
    assert.equal(store.project(project.id).stage, stages.INCUBATING);
  } finally { dispose(); }
});
