import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage();
const sensitiveKeyPattern = /(authorization|cookie|token|secret|password|credential|payload|content|problem|rationale|comment|email|employee|link|url|body|claim)/i;
const allowedExporterLabels = new Set(["stdout", "otlp"]);

export function currentObservabilityContext() {
  return context.getStore() || {};
}

export function correlationIdFromHeaders(headers = {}) {
  const value = String(headers["x-correlation-id"] || "").trim();
  return /^[a-zA-Z0-9_.:-]{8,80}$/.test(value) ? value : randomUUID();
}

export function sanitizeTelemetry(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeTelemetry(item));
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKeyPattern.test(key) ? "[redacted]" : sanitizeTelemetry(item)
  ]));
}

function labelKey(labels = {}) {
  return JSON.stringify(Object.keys(labels).sort().map(key => [key, String(labels[key] ?? "")]));
}

export class ApplicationMetrics {
  constructor() {
    this.counters = new Map();
  }

  increment(name, labels = {}, amount = 1) {
    const key = `${name}:${labelKey(labels)}`;
    const existing = this.counters.get(key) || { name, labels: sanitizeTelemetry(labels), count: 0 };
    existing.count += amount;
    this.counters.set(key, existing);
  }

  snapshot() {
    return {
      counters: [...this.counters.values()].map(counter => ({
        name: counter.name,
        labels: counter.labels,
        count: counter.count
      }))
    };
  }
}

export class Observability {
  constructor({ exporter = "stdout", logger = console, metrics = new ApplicationMetrics(), enabled = true } = {}) {
    this.exporter = exporter;
    this.logger = logger;
    this.metrics = metrics;
    this.enabled = enabled;
  }

  withContext(data, work) {
    return context.run({ ...currentObservabilityContext(), ...data }, work);
  }

  emit(event, fields = {}) {
    const record = sanitizeTelemetry({
      event,
      timestamp: new Date().toISOString(),
      correlationId: currentObservabilityContext().correlationId,
      ...fields
    });
    if (this.enabled && this.exporter === "stdout" && typeof this.logger?.log === "function") {
      this.logger.log(JSON.stringify(record));
    }
    return record;
  }

  request(fields = {}) {
    const statusClass = `${Math.floor(Number(fields.statusCode || 0) / 100)}xx`;
    this.metrics.increment("http_requests_total", {
      method: fields.method,
      route: fields.route,
      statusClass
    });
    return this.emit("request", fields);
  }

  workflow(fields = {}) {
    this.metrics.increment("workflow_events_total", { route: fields.route, result: fields.result || "success" });
    return this.emit("workflow", fields);
  }

  integration(fields = {}) {
    this.metrics.increment("integration_events_total", {
      integrationType: fields.integrationType,
      operation: fields.operation,
      outcome: fields.outcome
    });
    return this.emit("integration", fields);
  }

  security(fields = {}) {
    this.metrics.increment("security_events_total", { code: fields.code, statusCode: fields.statusCode });
    return this.emit("security", fields);
  }

  snapshot() {
    return this.metrics.snapshot();
  }
}

export function createObservability({ env = process.env, demoMode = false, logger = console } = {}) {
  const configured = String(env.LABS_OBSERVABILITY_EXPORTER || "").trim();
  const exporter = configured || (demoMode ? "stdout" : "");
  const enabled = exporter === "stdout";
  if (!demoMode && !allowedExporterLabels.has(exporter)) {
    return new Observability({ exporter: "disabled", logger, enabled: false });
  }
  return new Observability({ exporter, logger, enabled });
}
