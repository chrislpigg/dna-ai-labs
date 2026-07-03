import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const operations = await readFile(new URL("../docs/production-operations-runbook.md", import.meta.url), "utf8");
const auditIntegrity = await readFile(new URL("../docs/audit-integrity-runbook.md", import.meta.url), "utf8");
const backupRestore = await readFile(new URL("../docs/backup-and-restore-runbook.md", import.meta.url), "utf8");

test("production operations runbook covers required procedures and related runbooks", () => {
  for (const heading of [
    "## Deployment Procedure",
    "## Rollback Procedure",
    "## Incident Response",
    "## Access Review Procedure",
    "## Dependency Outage Procedure",
    "## Feature-Flag Rollback Procedure"
  ]) {
    assert.match(operations, new RegExp(heading.replaceAll("#", "\\#")));
  }
  assert.match(operations, /docs\/backup-and-restore-runbook\.md/);
  assert.match(operations, /docs\/audit-integrity-runbook\.md/);
  assert.match(operations, /GET \/readyz/);
  assert.match(operations, /GET \/api\/v1\/audit-events\/verify/);
  assert.match(operations, /feature_flag_updated/);
});

test("operations runbooks list role-based ownership and avoid invented contacts or secrets", () => {
  for (const role of [
    "Application operations owner",
    "DNA AI Labs program administrator",
    "Database platform owner",
    "Security and compliance owners",
    "Identity platform owner",
    "Integration owner",
    "Executive sponsor and receiving owner"
  ]) {
    assert.match(operations, new RegExp(role));
  }
  const combined = `${operations}\n${auditIntegrity}`;
  for (const forbidden of [
    /@[a-z0-9.-]+\.[a-z]{2,}/i,
    /\b\d{3}[-.]\d{3}[-.]\d{4}\b/,
    /Bearer\s+[A-Za-z0-9._-]+/,
    /postgres:\/\/[^`\s)]+/i,
    /slack:\/\/|mailto:/i
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
  assert.match(combined, /Do not .*member data/);
  assert.match(combined, /Do not .*access tokens/);
});

test("audit integrity runbook defines verification, failure response, and restore handoff", () => {
  assert.match(auditIntegrity, /GET \/api\/v1\/audit-events\/verify/);
  assert.match(auditIntegrity, /valid: true/);
  assert.match(auditIntegrity, /sequence gap, hash mismatch/);
  assert.match(auditIntegrity, /Do not rewrite audit rows/);
  assert.match(auditIntegrity, /docs\/backup-and-restore-runbook\.md/);
});

test("backup and restore runbook remains linked to audit verification", () => {
  assert.match(backupRestore, /GET \/api\/v1\/audit-events\/verify/);
  assert.match(backupRestore, /audit-integrity outcome/);
  assert.match(backupRestore, /Record only metadata and approved links/);
});
