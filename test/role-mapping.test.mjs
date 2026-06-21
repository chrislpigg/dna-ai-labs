import test from "node:test";
import assert from "node:assert/strict";
import { demoGroupRoleMapping, parseGroupRoleMapping, resolveApplicationRole } from "../src/role-mapping.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

const mapping = {
  employee: ["employees"],
  submitter: ["submitters"],
  "project-lead": ["project-leads"],
  fellow: ["fellows"],
  "receiving-owner": ["receiving-owners"],
  "steering-reviewer": ["steering-reviewers"],
  "lab-lead": ["lab-leads"],
  "executive-sponsor": ["executive-sponsors"],
  "platform-reviewer": ["platform-reviewers"],
  admin: ["program-administrators"]
};

test("a complete configured verified-group mapping resolves every application role", () => {
  const parsed = parseGroupRoleMapping(JSON.stringify(mapping));
  assert.ok(parsed);
  for (const [role, groups] of Object.entries(mapping)) assert.equal(resolveApplicationRole(groups, parsed), role);
});

test("a verified identity without a mapped group is denied", () => {
  const parsed = parseGroupRoleMapping(mapping);
  assert.throws(() => resolveApplicationRole(["unrelated-group"], parsed), error => error instanceof WorkflowError && error.code === "UNMAPPED_ROLE" && error.status === 403);
});

test("invalid mappings and ambiguous verified roles are rejected", () => {
  assert.equal(parseGroupRoleMapping({ employee: ["employees"] }), null);
  const parsed = parseGroupRoleMapping(mapping);
  const ambiguous = { ...parsed, submitter: Object.freeze(["employees"]), employee: Object.freeze(["employees"]) };
  assert.throws(() => resolveApplicationRole(["employees"], ambiguous), error => error instanceof WorkflowError && error.code === "AMBIGUOUS_ROLE_MAPPING" && error.status === 403);
});

test("demo mapping is explicit and maps only the selected demo role", () => {
  const mapping = demoGroupRoleMapping();
  assert.equal(resolveApplicationRole(["lab-lead"], mapping), "lab-lead");
});
