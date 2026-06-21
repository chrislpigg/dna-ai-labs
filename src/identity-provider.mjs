import { WorkflowError } from "./workflow-policy.mjs";

function nonEmptyText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function immutableIdentity(identity) {
  const subject = nonEmptyText(identity?.subject);
  const organization = nonEmptyText(identity?.organization);
  const sessionExpiresAt = nonEmptyText(identity?.sessionExpiresAt);
  const groups = Array.isArray(identity?.groups)
    ? [...new Set(identity.groups.map(nonEmptyText).filter(Boolean))]
    : [];

  if (!subject || !organization || !sessionExpiresAt || Number.isNaN(Date.parse(sessionExpiresAt))) {
    throw new WorkflowError("INVALID_VERIFIED_IDENTITY", "The identity provider returned an invalid verified identity.", 401);
  }

  return Object.freeze({ subject, groups: Object.freeze(groups), organization, sessionExpiresAt });
}

/**
 * Server-side identity-provider contract. Implementations must return only
 * identities they have verified, never claims copied from caller-controlled
 * request headers.
 */
export class IdentityProvider {
  authenticate(_request) {
    throw new Error("IdentityProvider implementations must implement authenticate().");
  }
}

/**
 * Seeded identity adapter for explicit demo mode and focused tests. It is not
 * available from the production factory path.
 */
export class DemoIdentityProvider extends IdentityProvider {
  constructor(identities, { defaultSubject } = {}) {
    super();
    this.identities = new Map(Object.entries(identities || {}).map(([subject, identity]) => [subject, immutableIdentity({ ...identity, subject })]));
    this.defaultSubject = nonEmptyText(defaultSubject);
  }

  authenticate(request) {
    const subject = nonEmptyText(request?.headers?.["x-labs-actor"]) || this.defaultSubject;
    const identity = this.identities.get(subject);
    if (!identity) throw new WorkflowError("UNAUTHENTICATED", "A valid demo identity is required.", 401);
    return identity;
  }
}

/**
 * Fail-closed placeholder for production until a verified token adapter is
 * configured. In particular, identity proxy headers are never trusted here.
 */
export class RejectingIdentityProvider extends IdentityProvider {
  authenticate(_request) {
    throw new WorkflowError("UNVERIFIED_IDENTITY", "The production identity provider must verify the request before identity claims can be used.", 401);
  }
}

export function createIdentityProvider({ demoMode, demoIdentities, demoDefaultSubject } = {}) {
  if (demoMode === true) {
    return new DemoIdentityProvider(demoIdentities, { defaultSubject: demoDefaultSubject });
  }
  return new RejectingIdentityProvider();
}

export function createTestIdentityProvider(identities, options = {}) {
  return new DemoIdentityProvider(identities, options);
}
