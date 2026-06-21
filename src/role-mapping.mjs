import { roles, WorkflowError } from "./workflow-policy.mjs";

export const applicationRoles = Object.freeze(Object.values(roles));

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedGroups(value) {
  if (!Array.isArray(value)) return null;
  const groups = value.map(text).filter(Boolean);
  return groups.length === value.length && new Set(groups).size === groups.length ? groups : null;
}

/**
 * Parses the non-secret LABS_GROUP_ROLE_MAPPING contract. Every application
 * role must have at least one distinct verified IdP group. Distinct group
 * ownership keeps a user from acquiring a union of workflow privileges.
 */
export function parseGroupRoleMapping(value) {
  let input;
  try {
    input = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== applicationRoles.length || keys.some(role => !applicationRoles.includes(role))) return null;

  const usedGroups = new Set();
  const mapping = {};
  for (const role of applicationRoles) {
    const groups = normalizedGroups(input[role]);
    if (!groups || groups.some(group => usedGroups.has(group))) return null;
    groups.forEach(group => usedGroups.add(group));
    mapping[role] = Object.freeze(groups);
  }
  return Object.freeze(mapping);
}

export function demoGroupRoleMapping() {
  return Object.freeze(Object.fromEntries(applicationRoles.map(role => [role, Object.freeze([role])])));
}

export function resolveApplicationRole(groups, mapping) {
  if (!mapping) throw new WorkflowError("ROLE_MAPPING_UNAVAILABLE", "Application role mapping is not configured.", 503);
  const verifiedGroups = new Set(Array.isArray(groups) ? groups.map(text).filter(Boolean) : []);
  const matchedRoles = applicationRoles.filter(role => mapping[role]?.some(group => verifiedGroups.has(group)));
  if (!matchedRoles.length) {
    throw new WorkflowError("UNMAPPED_ROLE", "No application role is mapped to the verified identity.", 403);
  }
  if (matchedRoles.length > 1) {
    throw new WorkflowError("AMBIGUOUS_ROLE_MAPPING", "The verified identity maps to more than one application role.", 403);
  }
  return matchedRoles[0];
}
