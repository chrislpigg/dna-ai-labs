# Production Operations Runbook

## Scope and Ownership

This runbook covers deployment, rollback, incident response, access review, dependency outage response, and feature-flag rollback for the DNA AI Labs Command Center production pilot.

Ownership is role-based:

- Application operations owner: coordinates deploy, rollback, smoke test, and readiness evidence.
- DNA AI Labs program administrator: owns pilot go/no-go coordination, audit exports, access reviews, and feature-flag changes.
- Database platform owner: owns PostgreSQL availability, migrations support, backup, restore, and isolated recovery targets.
- Security and compliance owners: own incident classification, audit-integrity investigation, privacy/security review, and approval to resume after integrity or access concerns.
- Identity platform owner: owns OIDC issuer, JWKS, group claims, and verified-group availability.
- Integration owner: owns each configured artifact, notification, work-tracking, calendar, analytics, and observability provider.
- Executive sponsor and receiving owner: approve pilot launch or rollback when user-facing workflow continuity or ownership commitments are affected.

Escalate through the approved corporate incident, change, access-review, and service-owner paths. Do not invent or store personal names, phone numbers, chat handles, email addresses, access tokens, secrets, raw production logs, member data, DNA data, health data, family-history data, or employee data in this repository.

## Deployment Procedure

1. Confirm the release commit has passed `npm test` and `npm run check`.
2. Confirm the required production configuration contract in `docs/runtime-configuration.md`: OIDC, tenant id, database URL, approved artifact origins, notification/integration providers, durable rate-limit store, and observability exporter.
3. Confirm preview or production environment variables exist through the approved deployment platform. If required variables are absent, stop and report the configuration blocker.
4. Run `npm run migrate` only against the approved PostgreSQL target and through the approved deployment mechanism.
5. Deploy the immutable application artifact.
6. Check `GET /readyz`; production readiness must report current migrations and no issue codes.
7. Check `GET /api/v1/audit-events/verify` as an authorized administrator; see `docs/audit-integrity-runbook.md`.
8. Run role-appropriate smoke tests for session, portfolio read, intake draft save, project brief, feature flags, audit read, and configured integrations. Use only metadata and approved links.
9. Record the release id, environment, readiness result, audit-integrity result, smoke-test result, approver roles, and approved evidence links in the operations system.

## Rollback Procedure

1. Declare a rollback change or incident through the approved corporate process.
2. Preserve the failing release id, correlation ids, readiness issue codes, and non-sensitive telemetry metadata.
3. Disable newly introduced non-critical behavior with feature flags when that is sufficient and safer than a redeploy.
4. Redeploy the last approved application artifact if application behavior must be reverted.
5. Do not roll back database schema manually. Migrations are forward-only unless the database platform owner and security/compliance owners approve a restore or corrective migration.
6. If data integrity, migration history, or audit hash-chain validity is in doubt, follow `docs/backup-and-restore-runbook.md` and `docs/audit-integrity-runbook.md`.
7. Re-run `GET /readyz`, `GET /api/v1/audit-events/verify`, and role-appropriate smoke tests before closing the rollback.

## Incident Response

1. Classify the incident through the approved incident process and assign the incident owner role.
2. Keep the service fail-closed. Do not enable demo mode, caller-supplied identity, SQLite, or in-memory production substitutes to restore service.
3. Capture only metadata: time window, route, stable error code, status code, correlation id, actor id where already approved, tenant id, deployment id, provider name, and approved links.
4. For security, privacy, access, audit-integrity, or data-retention concerns, engage security/compliance owners and preserve evidence before remediation.
5. For database concerns, engage the database platform owner and use the backup/restore and audit-integrity runbooks.
6. For dependency concerns, use the dependency outage procedure below.
7. Document mitigation, customer/user impact, final owner approval, and follow-up actions in the approved incident system.

## Access Review Procedure

1. Review OIDC group-to-role mappings in `LABS_GROUP_ROLE_MAPPING` at least quarterly and before pilot launch.
2. Confirm every application role maps to the approved verified group and no group maps to more than one role.
3. Review admin, lab lead, executive sponsor, platform reviewer, receiving owner, project lead, submitter, and employee access through the identity platform owner and program administrator.
4. Remove stale group membership in the identity provider. Do not edit production role state directly in the database.
5. Verify access changes through sign-in, `GET /api/v1/session`, role-appropriate denied actions, and audit events.
6. Record only role, group, review date, reviewer role, exceptions, and approved evidence links.

## Dependency Outage Procedure

1. OIDC outage: production authentication fails closed. Engage the identity platform owner. Do not accept identity headers or switch to demo identities.
2. PostgreSQL outage: API mutations and reads fail closed. Engage the database platform owner and use readiness issue codes plus approved database telemetry.
3. Artifact verifier outage: evidence-backed gates must not complete. Keep allow-list checks active and engage the integration owner.
4. Notification outage: keep workflow mutations transactional; use the notification worker retry and dead-letter metadata. Engage the notification provider owner.
5. Work-tracking, calendar, analytics, or observability outage: disable optional surfaces with feature flags where available, keep governed workflow state authoritative, and record provider issue metadata only.
6. For any outage that affects launch readiness, require program administrator and affected owner approval before continuing the pilot.

## Feature-Flag Rollback Procedure

1. Identify the affected feature flag and confirm it is safe to disable for the tenant.
2. As an administrator, update the flag through the governed feature-flag API or UI. Do not edit the database directly.
3. Confirm the flag response reflects the intended state and that protected behavior is blocked or restored.
4. Confirm an audit event with action `feature_flag_updated` exists for the flag.
5. Record the flag key, previous state, next state, actor role, reason, validation result, and approved incident or change link.
6. If disabling a flag is insufficient, use the rollback procedure above.

## Related Runbooks

- Backup and restore: `docs/backup-and-restore-runbook.md`
- Audit integrity verification: `docs/audit-integrity-runbook.md`
- Runtime configuration: `docs/runtime-configuration.md`
- Accessibility validation: `docs/accessibility-validation.md`
