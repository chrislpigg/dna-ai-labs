import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const checklist = await readFile(new URL("../docs/pilot-readiness-checklist.md", import.meta.url), "utf8");
const spec = await readFile(new URL("../SPEC.md", import.meta.url), "utf8");

test("pilot readiness checklist includes all required approval lanes", () => {
  for (const lane of ["Security", "Privacy", "Accessibility", "Operations", "Sponsor", "Receiving owner"]) {
    assert.match(checklist, new RegExp(`\\| ${lane} \\|`));
  }
  assert.match(checklist, /Go\/No-Go Rule/);
  assert.match(checklist, /Any missing approval[\s\S]*is `no-go`/);
});

test("pilot readiness checklist captures production configuration and integration dependencies", () => {
  for (const required of [
    "LABS_DEMO_MODE",
    "OIDC issuer",
    "Tenant id",
    "PostgreSQL database URL",
    "npm run migrate",
    "Approved artifact origins",
    "LABS_RATE_LIMIT_STORE=postgres",
    "LABS_OBSERVABILITY_EXPORTER",
    "Company directory",
    "Approved artifact verifier",
    "Notification delivery",
    "Work tracking",
    "Calendar/video",
    "Analytics/metrics",
    "Observability",
    "Backup/restore"
  ]) {
    assert.match(checklist, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(checklist, /docs\/runtime-configuration\.md/);
  assert.match(checklist, /docs\/backup-and-restore-runbook\.md/);
  assert.match(checklist, /docs\/production-operations-runbook\.md/);
});

test("pilot readiness checklist documents every SPEC launch-blocking scenario", () => {
  const scenarios = [
    "A project lead cannot approve their own final decision.",
    "A project cannot be transferred without a receiving-owner acceptance, complete/accepted gates, delivery kit, and scheduled follow-up.",
    "A project cannot be extended more than once.",
    "A project cannot report a validated impact without a baseline, result, source, measurement date, and measurement owner.",
    "A user cannot access another organization’s restricted project or audit events.",
    "Every mutation creates a durable audit event and can be restored after a tested backup recovery.",
    "An employee can complete the intake and decision-review workflows using keyboard only and with a screen reader.",
    "The dashboard clearly separates candidates, active projects, hypotheses, and verified outcomes."
  ];
  for (const scenario of scenarios) {
    assert.match(spec, new RegExp(scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(checklist, new RegExp(scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("pilot readiness checklist keeps evidence metadata-only and avoids invented contacts", () => {
  for (const forbidden of [
    /@[a-z0-9.-]+\.[a-z]{2,}/i,
    /\b\d{3}[-.]\d{3}[-.]\d{4}\b/,
    /Bearer\s+[A-Za-z0-9._-]+/,
    /postgres:\/\/[^`\s)]+/i,
    /slack:\/\/|mailto:/i
  ]) {
    assert.doesNotMatch(checklist, forbidden);
  }
  assert.match(checklist, /Record only metadata/);
  assert.match(checklist, /do not add personal contacts, secrets, raw production logs/);
});
