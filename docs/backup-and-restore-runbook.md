# Backup and restore runbook

## Scope and ownership

The selected company-managed PostgreSQL service owns encrypted backups, point-in-time recovery, retention, and access to restore controls. The DNA AI Labs program administrator owns this runbook and coordinates application verification. The database platform owner performs the restore; the security and compliance owners are engaged for any suspected data-integrity or unauthorized-access event. Do not use the demo SQLite database as a production backup source or target.

## Targets

- RPO: 24 hours or the stricter managed-database/corporate requirement.
- RTO: 4 hours or the stricter managed-database/corporate requirement.
- Restore test: at least once per quarter, and after a material database-provider or schema change.

## Backup verification

1. Confirm the production database is company-managed and automated backups/PITR are enabled by the platform owner.
2. Record only the provider confirmation, backup-window status, and test ticket/reference in approved operations systems. Never copy connection strings, member data, DNA/health data, employee data, tokens, or logs into this runbook.
3. Escalate a missing or failed backup to the database platform on-call path; do not proceed with a pilot launch while the required recovery posture is unknown.

## Controlled restore procedure

1. Declare an incident or scheduled restore change through the approved corporate process and identify the exact recovery point.
2. The database platform owner restores to an isolated, access-controlled target. Do not overwrite the active authoritative database before validation.
3. Configure the application only through the approved secret/configuration mechanism. Required OIDC, tenant, artifact, and integration contracts must remain present; never paste values into tickets or source control.
4. Run `npm run migrate` against the restored target using the approved deployment mechanism. A migration checksum or pending-migration failure is a restore blocker.
5. Check `GET /readyz`; it must report production mode, database connectivity `available`, migration state `current`, and no issue codes.
6. As an authorized administrator, call `GET /api/v1/audit-events/verify`. It must return `valid: true`. Treat a sequence gap or hash mismatch as an integrity incident; preserve the target for investigation and escalate to security/compliance and the database platform owner.
7. Perform the approved role-appropriate smoke tests without entering sensitive source data. Obtain incident/change approval before switching traffic or declaring recovery complete.

## Quarterly restore test evidence

For each test, record the date, target environment class, chosen recovery point, measured recovery duration, migration/readiness outcome, audit-integrity outcome, responsible platform owner, and follow-up actions in the approved operations system. Record only metadata and approved links. Any failure to meet RPO/RTO, verify audit integrity, or establish configured production readiness requires an owner and escalation before the next pilot decision.
