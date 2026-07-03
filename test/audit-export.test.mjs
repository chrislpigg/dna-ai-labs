import test from "node:test";
import assert from "node:assert/strict";
import { auditEventsToCsv, normalizeAuditExportInput } from "../src/audit-export.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

test("audit export bounds require valid from and to dates", () => {
  const bounds = normalizeAuditExportInput({ from: "2026-07-01", to: "2026-07-02", limit: 9000 });
  assert.equal(bounds.from, "2026-07-01T00:00:00.000Z");
  assert.equal(bounds.to, "2026-07-02T23:59:59.999Z");
  assert.equal(bounds.limit, 5000);
  assert.throws(
    () => normalizeAuditExportInput({ from: "2026-07-03", to: "2026-07-02" }),
    error => error instanceof WorkflowError && error.code === "INVALID_AUDIT_EXPORT_BOUNDS"
  );
});

test("audit export CSV neutralizes formula-leading cells", () => {
  const csv = auditEventsToCsv([{
    id: "=cmd",
    createdAt: "2026-07-02T12:00:00.000Z",
    actorId: "+admin",
    action: "-delete",
    entityType: "@project",
    entityId: "\tA1",
    before: null,
    after: { summary: "metadata only" }
  }], {
    exportId: "export-1",
    generatedAt: "2026-07-02T12:01:00.000Z",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-02T23:59:59.999Z"
  });
  assert.match(csv, /,'=cmd,/);
  assert.match(csv, /,'\+admin,/);
  assert.match(csv, /,'-delete,/);
  assert.match(csv, /,'@project,/);
  assert.match(csv, /,'\tA1,/);
});
