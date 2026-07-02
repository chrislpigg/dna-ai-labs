const directoryContextStaleMs = 7 * 24 * 60 * 60 * 1000;

const assignmentSpecs = Object.freeze([
  ["metricOwner", "Metric owner", project => project.metricOwnerId],
  ["sponsor", "Sponsor", project => project.sponsor?.id],
  ["receivingOwner", "Receiving owner", project => project.receivingOwner?.id],
  ["projectLead", "Project lead", project => project.projectLead?.id]
]);

function staleDirectoryContext(verifiedAt, nowMs = Date.now()) {
  const timestamp = Date.parse(verifiedAt);
  return !Number.isFinite(timestamp) || nowMs - timestamp > directoryContextStaleMs;
}

function allowedDirectoryContext(person) {
  return {
    id: person.id,
    displayName: person.displayName,
    organization: person.organization,
    managerId: person.managerId,
    active: Boolean(person.active),
    verifiedAt: person.verifiedAt,
    stale: staleDirectoryContext(person.verifiedAt)
  };
}

function warning(code, assignment, userId, message, details = {}) {
  return { code, assignment, userId, message, ...details };
}

function applyDirectoryAssignments(project, results) {
  const directoryAssignments = {};
  const directoryWarnings = [];
  const next = { ...project };
  for (const result of results) {
    if (!result?.userId) continue;
    if (result.context) {
      directoryAssignments[result.key] = result.context;
      if (result.key === "metricOwner") {
        next.metricOwner = { id: result.userId, name: result.context.displayName, directory: result.context };
      } else if (next[result.key]) {
        next[result.key] = { ...next[result.key], directory: result.context };
      }
      if (!result.context.active) {
        directoryWarnings.push(warning("DIRECTORY_PERSON_INACTIVE", result.label, result.userId, `${result.label} is inactive in the company directory.`));
      }
      if (result.context.stale) {
        directoryWarnings.push(warning("DIRECTORY_CONTEXT_STALE", result.label, result.userId, `${result.label} directory context is stale.`, { verifiedAt: result.context.verifiedAt }));
      }
    }
    if (result.warning) directoryWarnings.push(result.warning);
  }
  return { ...next, directoryAssignments, directoryWarnings };
}

function lookupResult(key, label, userId, lookup) {
  if (!userId) return { key, label, userId: null, context: null };
  try {
    return { key, label, userId, context: allowedDirectoryContext(lookup(userId)) };
  } catch (error) {
    return {
      key, label, userId, context: null,
      warning: warning(error.code || "DIRECTORY_LOOKUP_FAILED", label, userId, `${label} directory context could not be verified.`)
    };
  }
}

export function enrichProjectDirectoryContextSync(project, directory) {
  const results = assignmentSpecs.map(([key, label, idForProject]) => lookupResult(key, label, idForProject(project), id => directory.lookupPersonSync(id)));
  return applyDirectoryAssignments(project, results);
}

export async function enrichProjectDirectoryContext(project, directory) {
  const results = await Promise.all(assignmentSpecs.map(async ([key, label, idForProject]) => {
    const userId = idForProject(project);
    if (!userId) return { key, label, userId: null, context: null };
    try {
      return { key, label, userId, context: allowedDirectoryContext(await directory.lookupPerson(userId)) };
    } catch (error) {
      return {
        key, label, userId, context: null,
        warning: warning(error.code || "DIRECTORY_LOOKUP_FAILED", label, userId, `${label} directory context could not be verified.`)
      };
    }
  }));
  return applyDirectoryAssignments(project, results);
}
