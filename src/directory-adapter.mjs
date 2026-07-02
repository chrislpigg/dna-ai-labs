import { WorkflowError } from "./workflow-policy.mjs";

const defaultTimeoutMs = 2000;

function directoryUnavailable(details) {
  return new WorkflowError("DIRECTORY_UNAVAILABLE", "The company directory is unavailable.", 503, details);
}

function withTimeout(work, timeoutMs, operation) {
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => setTimeout(() => reject(new WorkflowError("DIRECTORY_TIMEOUT", "The company directory lookup timed out.", 503, { operation, timeoutMs })), timeoutMs))
  ]);
}

export function normalizeDirectoryPerson(input = {}) {
  const id = String(input.id ?? input.userId ?? "").trim();
  const displayName = String(input.displayName ?? input.name ?? "").trim();
  const organization = String(input.organization ?? input.organizationName ?? "").trim();
  const managerId = String(input.managerId ?? "").trim();
  const active = Boolean(input.active);
  if (!id || !displayName || !organization) {
    throw new WorkflowError("INVALID_DIRECTORY_RECORD", "Directory person record is incomplete.", 502);
  }
  return {
    id,
    displayName,
    organization,
    managerId: managerId || null,
    active,
    verifiedAt: input.verifiedAt || new Date().toISOString()
  };
}

export class DirectoryAdapter {
  constructor({ lookupPerson, lookupPersonSync, searchPeople, timeoutMs = defaultTimeoutMs } = {}) {
    if (typeof lookupPerson !== "function" && typeof lookupPersonSync !== "function") throw new TypeError("lookupPerson provider is required.");
    if (typeof searchPeople !== "function") throw new TypeError("searchPeople provider is required.");
    this.provider = { lookupPerson, lookupPersonSync, searchPeople };
    this.timeoutMs = Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 10000) : defaultTimeoutMs;
  }

  async lookupPerson(id) {
    const userId = String(id ?? "").trim();
    if (!userId) throw new WorkflowError("INVALID_DIRECTORY_LOOKUP", "Directory lookup requires a user id.", 422);
    try {
      const result = await withTimeout(() => this.provider.lookupPerson ? this.provider.lookupPerson(userId) : this.provider.lookupPersonSync(userId), this.timeoutMs, "lookupPerson");
      if (!result) throw new WorkflowError("DIRECTORY_PERSON_NOT_FOUND", "Directory person was not found.", 404);
      return normalizeDirectoryPerson(result);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw directoryUnavailable({ operation: "lookupPerson" });
    }
  }

  lookupPersonSync(id) {
    const userId = String(id ?? "").trim();
    if (!userId) throw new WorkflowError("INVALID_DIRECTORY_LOOKUP", "Directory lookup requires a user id.", 422);
    try {
      const result = this.provider.lookupPersonSync ? this.provider.lookupPersonSync(userId) : this.provider.lookupPerson(userId);
      if (result && typeof result.then === "function") throw directoryUnavailable({ operation: "lookupPerson", mode: "sync" });
      if (!result) throw new WorkflowError("DIRECTORY_PERSON_NOT_FOUND", "Directory person was not found.", 404);
      return normalizeDirectoryPerson(result);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw directoryUnavailable({ operation: "lookupPerson" });
    }
  }

  async searchPeople(query) {
    const text = String(query ?? "").trim();
    if (text.length < 2) throw new WorkflowError("INVALID_DIRECTORY_SEARCH", "Directory search requires at least two characters.", 422);
    try {
      const results = await withTimeout(() => this.provider.searchPeople(text), this.timeoutMs, "searchPeople");
      if (!Array.isArray(results)) throw new WorkflowError("INVALID_DIRECTORY_RESPONSE", "Directory search response is invalid.", 502);
      return results.map(result => normalizeDirectoryPerson(result));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw directoryUnavailable({ operation: "searchPeople" });
    }
  }
}

export class DisabledDirectoryAdapter {
  async lookupPerson() { throw directoryUnavailable({ configured: false }); }
  lookupPersonSync() { throw directoryUnavailable({ configured: false }); }
  async searchPeople() { throw directoryUnavailable({ configured: false }); }
}

export function createDirectoryAdapter({ provider, timeoutMs } = {}) {
  if (!provider) return new DisabledDirectoryAdapter();
  return new DirectoryAdapter({ ...provider, timeoutMs });
}

export async function requireActiveDirectoryPerson(directory, id, label = "person") {
  const person = await directory.lookupPerson(id);
  if (!person.active) throw new WorkflowError("DIRECTORY_PERSON_INACTIVE", `${label} is not active in the company directory.`, 422, { userId: person.id });
  return person;
}

export function requireActiveDirectoryPersonSync(directory, id, label = "person") {
  const person = directory.lookupPersonSync(id);
  if (!person.active) throw new WorkflowError("DIRECTORY_PERSON_INACTIVE", `${label} is not active in the company directory.`, 422, { userId: person.id });
  return person;
}
