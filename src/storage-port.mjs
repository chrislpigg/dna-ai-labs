/**
 * Persistence boundary for governed workflow state.
 *
 * Implementations own database-specific queries and transactions. Workflow
 * services may only use this contract, which keeps SQLite strictly a demo/test
 * adapter and leaves production storage replaceable.
 */
export const storagePortMethods = Object.freeze([
  "getActor", "listUsers", "getProject", "getProjectIncludingDeleted", "listProjects",
  "insertProject", "updateProjectStage", "acknowledgeProjectAdoption",
  "upsertGate", "insertEvidence", "upsertReview", "listReviews",
  "getHandoff", "upsertHandoff",
  "findOpenDecision", "insertDecision", "getDecision", "listApprovals",
  "insertApproval", "rejectDecision", "finalizeDecision", "softDeleteProject", "restoreProject",
  "appendAudit", "listAuditEvents", "transaction", "health", "close"
]);

export function assertStoragePort(storage) {
  const missing = storagePortMethods.filter(method => typeof storage?.[method] !== "function");
  if (missing.length) {
    throw new TypeError(`Storage adapter is missing required methods: ${missing.join(", ")}`);
  }
  return storage;
}
