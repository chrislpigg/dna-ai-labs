# Audit Integrity Verification Runbook

## Scope and Ownership

The durable audit log is the governed record of workflow mutations, security-relevant configuration changes, exports, approvals, and lifecycle decisions. The DNA AI Labs program administrator owns routine verification. The database platform owner supports database evidence preservation. The security and compliance owners lead investigation for any suspected tampering, sequence gap, hash mismatch, or unauthorized access.

Use only approved incident, change, and evidence systems for coordination. Do not add names, phone numbers, chat handles, access tokens, database exports, raw member data, health data, family-history data, employee data, production logs, or connection strings to this repository.

## Routine Verification

1. Authenticate as an authorized administrator in the target environment.
2. Confirm `GET /readyz` reports the expected production mode, current migrations, and no issue codes.
3. Call `GET /api/v1/audit-events/verify`.
4. Record only the environment class, verification time, correlation id, result, and approved ticket or evidence link.
5. A valid result must report `valid: true`.

## Failure Response

1. Treat any invalid result, sequence gap, hash mismatch, unexpected genesis, or database error as an integrity incident.
2. Stop deployments, audit exports, and manual data correction attempts for the affected tenant until the incident owner authorizes next steps.
3. Preserve the database target and relevant approved telemetry metadata. Do not rewrite audit rows or attempt to patch the hash chain in place.
4. Escalate through the approved security/compliance incident path and include the database platform owner.
5. Use the backup and restore runbook if a restore or isolated forensic target is required: `docs/backup-and-restore-runbook.md`.
6. After recovery, rerun `GET /api/v1/audit-events/verify`, `GET /readyz`, `npm test`, and `npm run check` before returning the environment to pilot use.

## Evidence

Store the verification record, incident link, owner role, decision, and retest result in the approved operations system. Keep this repository limited to the runbook procedure and approved documentation links.
