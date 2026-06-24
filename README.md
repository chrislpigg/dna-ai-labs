# DNA AI Labs Command Center

A local, governed implementation foundation for the DNA AI Labs command center. It includes a server-owned SQLite portfolio, workflow policy, append-only audit events, guarded decision requests, and a browser UI.

It is **not yet a production company deployment**. The local runtime deliberately uses a demo identity and SQLite so the workflow can be verified without access to company identity, managed database, directory, work-tracking, document, analytics, and notification systems. The production requirements, governance model, security controls, data model, lifecycle gates, test strategy, and delivery plan are defined in [SPEC.md](./SPEC.md).

## What it supports

- Server-owned portfolio view for the Accessibility and UBE lighthouse projects.
- Auditable project intake with evidence, adoption, ownership, and metric requirements.
- Lifecycle controls for adoption acknowledgement, selection, and incubation; a named receiving owner must explicitly acknowledge the path before selection.
- Decision requests with independent approval requirements, an enforced one-extension limit, and outcome-specific transfer/scale/sunset gates.
- Reviewer approval and receiving-owner handoff acceptance workspaces, including adoption plan, support boundary, onboarding acknowledgement, and 30-day follow-up date.
- A role-restricted, read-only governance audit log for Lab leads, executive sponsors, and program administrators.
- Structured pilot evidence with result, sample size, confidence, source, and measurement date; metric gates cannot be marked complete without a real metric record.
- Risk-based review tracking: accessibility and responsible-AI reviews for internal work, plus security and privacy for confidential or restricted work.
- Rejected decisions return projects to incubation, retain their rationale in project history and audit records, and allow a revised request.
- Approved-origin validation for evidence links and static-file protections for the local database.
- A 90-day operating cadence and an executive-demo checklist.
- Automated workflow tests for authorization, transfer gating, independent approvals, audit logging, and evidence-link restrictions.

## Run locally

```bash
cd /Users/piggagenticsystem/projects/dna-ai-labs
npm start
```

Open `http://localhost:4173`.

`npm start` explicitly enables a clearly labelled **demo identity** and allows role-switching only in the local command center. It must never be deployed outside a development environment. Use `npm test` to run the workflow suite and `npm run check` for syntax checks.

Vercel does not implicitly enable demo mode. A preview may use the demo runtime only when `LABS_DEMO_MODE=true` is explicitly configured for that preview environment; its `/tmp` SQLite data is ephemeral and remains demo-only.

## Production deployment prerequisites

Before a pilot or production deployment, configure the approved SSO/OIDC issuer, audience, JWKS URL, and complete server-side group-to-role mapping; use the company-managed relational database and backup process; configure approved internal artifact origins; and integrate the directory, work-tracking, document, analytics, calendar, and notification systems described in [SPEC.md](./SPEC.md). The full non-secret configuration contract is in [docs/runtime-configuration.md](./docs/runtime-configuration.md).

Run the tracked production schema migrations only with a company-approved PostgreSQL URL: `LABS_DATABASE_URL='postgresql://…' npm run migrate`. The command refuses demo mode and does not print the connection value. See [the migration procedure](./docs/runtime-configuration.md#postgresql-migrations) before deploying.

Production recovery uses the managed-database provider and the controlled [backup and restore runbook](./docs/backup-and-restore-runbook.md); it includes required audit-integrity verification after every restore.

Run `npm start:secure` only after the approved token-verification adapter and `LABS_ALLOWED_ARTIFACT_ORIGINS` are configured. The current production contract accepts only verified OIDC bearer tokens; it does not accept browser cookies or identity headers. With valid production configuration, portfolio, audit, and workflow writes use PostgreSQL with the configured tenant scope; every successful workflow write commits its audit event in the same transaction. Failed database operations return `DATABASE_UNAVAILABLE` and never fall back to demo data. Cookie-session support must use an HTTPS application origin and the server CSRF boundary before it can be enabled. Do not use this local foundation for member, employee, or other sensitive data.

## Operational probes

- `GET /healthz` confirms that the process and local data connection are alive.
- `GET /readyz` is deliberately **not ready** in demo mode and reports only non-secret issue codes. Non-demo deployments also remain fail-closed until the production identity and storage adapters are available. Use it for deployment readiness checks, not the public portfolio UI.
