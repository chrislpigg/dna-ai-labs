import test from "node:test";
import assert from "node:assert/strict";
import { createDirectoryAdapter, DirectoryAdapter, requireActiveDirectoryPerson } from "../src/directory-adapter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

const activePerson = {
  id: "user-1",
  displayName: "Taylor Submitter",
  organization: "Developer Experience",
  managerId: "manager-1",
  active: true,
  verifiedAt: "2026-06-20T00:00:00.000Z"
};

test("directory adapter normalizes active status, manager, organization, and display identity", async () => {
  const adapter = new DirectoryAdapter({
    lookupPerson: async id => ({ ...activePerson, id }),
    searchPeople: async () => [activePerson]
  });

  const person = await adapter.lookupPerson("user-1");
  assert.deepEqual(person, activePerson);
  assert.equal((await adapter.searchPeople("tay"))[0].organization, "Developer Experience");
  await assert.rejects(() => adapter.searchPeople("t"), error => error instanceof WorkflowError && error.code === "INVALID_DIRECTORY_SEARCH");
});

test("directory configuration can fail closed when no provider is configured", async () => {
  const adapter = createDirectoryAdapter();
  await assert.rejects(() => adapter.lookupPerson("user-1"), error => error instanceof WorkflowError && error.code === "DIRECTORY_UNAVAILABLE" && error.details.configured === false);
});

test("directory timeouts and provider failures never validate people silently", async () => {
  const slow = new DirectoryAdapter({
    lookupPerson: () => new Promise(resolve => setTimeout(() => resolve(activePerson), 20)),
    searchPeople: async () => [activePerson],
    timeoutMs: 1
  });
  await assert.rejects(() => slow.lookupPerson("user-1"), error => error instanceof WorkflowError && error.code === "DIRECTORY_TIMEOUT");

  const failing = new DirectoryAdapter({
    lookupPerson: async () => { throw new Error("provider secret"); },
    searchPeople: async () => []
  });
  await assert.rejects(() => failing.lookupPerson("user-1"), error => error instanceof WorkflowError && error.code === "DIRECTORY_UNAVAILABLE" && !error.message.includes("secret"));
});

test("active-person validation rejects inactive or unknown directory records", async () => {
  const inactive = new DirectoryAdapter({
    lookupPerson: async () => ({ ...activePerson, active: false }),
    searchPeople: async () => []
  });
  await assert.rejects(() => requireActiveDirectoryPerson(inactive, "user-1", "Sponsor"), error => error instanceof WorkflowError && error.code === "DIRECTORY_PERSON_INACTIVE");

  const unknown = new DirectoryAdapter({
    lookupPerson: async () => null,
    searchPeople: async () => []
  });
  await assert.rejects(() => requireActiveDirectoryPerson(unknown, "missing", "Sponsor"), error => error instanceof WorkflowError && error.code === "DIRECTORY_PERSON_NOT_FOUND");
});
