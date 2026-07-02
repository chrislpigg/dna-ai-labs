import { WorkflowError } from "./workflow-policy.mjs";

const defaultTimeoutMs = 2_000;
const metricSourceTypes = Object.freeze(["analytics_dashboard", "warehouse_query", "experiment_report"]);

function timeoutError() {
  return new WorkflowError("ANALYTICS_TIMEOUT", "Analytics verification timed out.", 504);
}

function normalizeMetricResult(result = {}) {
  const value = String(result.value ?? result.valueSummary ?? "").trim();
  if (!value || value.length > 160) throw new WorkflowError("INVALID_ANALYTICS_RESULT", "Analytics result value is invalid.", 502);
  const verifiedAt = result.verifiedAt || new Date().toISOString();
  const staleAt = result.staleAt || null;
  return {
    value,
    verifiedAt,
    staleAt,
    sourceRef: String(result.sourceRef ?? "").trim() || null
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); })
  ]);
}

export function normalizeMetricPlanInput(input = {}, existing = {}) {
  const metricKey = String(input.metricKey ?? existing.metricKey ?? "primary").trim();
  if (!/^[a-z0-9_:-]{1,64}$/.test(metricKey)) throw new WorkflowError("INVALID_METRIC_KEY", "Metric key is invalid.", 422);
  const sourceType = String(input.sourceType ?? existing.sourceType ?? "").trim();
  if (!metricSourceTypes.includes(sourceType)) throw new WorkflowError("INVALID_METRIC_SOURCE_TYPE", "Metric source type is invalid.", 422);
  const sourceRef = String(input.sourceRef ?? existing.sourceRef ?? "").trim();
  if (!sourceRef || sourceRef.length > 200) throw new WorkflowError("INVALID_METRIC_SOURCE_REF", "Metric source reference is invalid.", 422);
  const hypothesisLabel = String(input.hypothesisLabel ?? existing.hypothesisLabel ?? "").trim();
  if (!hypothesisLabel || hypothesisLabel.length > 160) throw new WorkflowError("INVALID_METRIC_HYPOTHESIS", "Metric hypothesis label is invalid.", 422);
  return { metricKey, sourceType, sourceRef, hypothesisLabel };
}

export class DisabledAnalyticsAdapter {
  refreshMetricSync() {
    throw new WorkflowError("ANALYTICS_UNAVAILABLE", "Analytics provider is not configured.", 503);
  }

  async refreshMetric() {
    throw new WorkflowError("ANALYTICS_UNAVAILABLE", "Analytics provider is not configured.", 503);
  }
}

export class AnalyticsAdapter {
  constructor({ refreshMetricSync, refreshMetric, timeoutMs = defaultTimeoutMs } = {}) {
    this.refreshMetricSyncProvider = refreshMetricSync;
    this.refreshMetricProvider = refreshMetric;
    this.timeoutMs = timeoutMs;
  }

  refreshMetricSync(plan, context = {}) {
    if (typeof this.refreshMetricSyncProvider !== "function") throw new WorkflowError("ANALYTICS_UNAVAILABLE", "Analytics provider is not configured.", 503);
    try {
      return normalizeMetricResult(this.refreshMetricSyncProvider({ plan, context }));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError("ANALYTICS_UNAVAILABLE", "Analytics provider is unavailable.", 503);
    }
  }

  async refreshMetric(plan, context = {}) {
    if (typeof this.refreshMetricProvider !== "function") throw new WorkflowError("ANALYTICS_UNAVAILABLE", "Analytics provider is not configured.", 503);
    try {
      return normalizeMetricResult(await withTimeout(Promise.resolve(this.refreshMetricProvider({ plan, context })), this.timeoutMs));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError("ANALYTICS_UNAVAILABLE", "Analytics provider is unavailable.", 503);
    }
  }
}
