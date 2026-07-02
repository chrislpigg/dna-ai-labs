import test from "node:test";
import assert from "node:assert/strict";
import { AnalyticsAdapter, DisabledAnalyticsAdapter, normalizeMetricPlanInput } from "../src/analytics-adapter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

test("analytics adapter normalizes verified metric values", () => {
  const adapter = new AnalyticsAdapter({
    refreshMetricSync: () => ({ value: "42 active teams", verifiedAt: "2026-07-02T00:00:00.000Z", staleAt: "2026-08-01T00:00:00.000Z", providerPayload: "ignored" })
  });
  const result = adapter.refreshMetricSync({ projectId: "project-1" });

  assert.deepEqual(result, {
    value: "42 active teams",
    verifiedAt: "2026-07-02T00:00:00.000Z",
    staleAt: "2026-08-01T00:00:00.000Z",
    sourceRef: null
  });
});

test("analytics adapter fails closed on missing provider, provider failure, and timeout", async () => {
  assert.throws(() => new DisabledAnalyticsAdapter().refreshMetricSync(), error => error instanceof WorkflowError && error.code === "ANALYTICS_UNAVAILABLE");
  assert.throws(() => new AnalyticsAdapter({ refreshMetricSync: () => { throw new Error("provider secret"); } }).refreshMetricSync({}), error => error instanceof WorkflowError && error.code === "ANALYTICS_UNAVAILABLE");
  await assert.rejects(
    () => new AnalyticsAdapter({ timeoutMs: 5, refreshMetric: () => new Promise(resolve => setTimeout(() => resolve({ value: "late" }), 50)) }).refreshMetric({}),
    error => error instanceof WorkflowError && error.code === "ANALYTICS_TIMEOUT"
  );
});

test("metric plan input is controlled source metadata", () => {
  assert.deepEqual(normalizeMetricPlanInput({
    sourceType: "analytics_dashboard",
    sourceRef: "dashboards/adoption-readiness",
    hypothesisLabel: "Expected reduction in review time"
  }), {
    metricKey: "primary",
    sourceType: "analytics_dashboard",
    sourceRef: "dashboards/adoption-readiness",
    hypothesisLabel: "Expected reduction in review time"
  });
  assert.throws(() => normalizeMetricPlanInput({ sourceType: "freeform", sourceRef: "x", hypothesisLabel: "x" }), error => error instanceof WorkflowError && error.code === "INVALID_METRIC_SOURCE_TYPE");
});
