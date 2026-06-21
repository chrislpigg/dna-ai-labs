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

`npm start` enables a clearly labelled **demo identity** and allows role-switching only in the local command center. It must never be deployed outside a development environment. Use `npm test` to run the workflow suite and `npm run check` for syntax checks.

Vercel preview deployments use the same demo mode and a writable `/tmp` SQLite file. That data is ephemeral across serverless instances and must be treated as a demo only.

## Production deployment prerequisites

Before a pilot or production deployment, replace the demo boundary with the approved SSO/OIDC identity proxy and server-side group mapping; use the company-managed relational database and backup process; configure approved internal artifact origins; and integrate the directory, work-tracking, document, analytics, calendar, and notification systems described in [SPEC.md](./SPEC.md).

Run `npm start:secure` only behind that approved identity proxy and with `LABS_ALLOWED_ARTIFACT_ORIGINS` configured. In secure mode, the service rejects requests until a real identity adapter is connected. Do not use this local foundation for member, employee, or other sensitive data.

## Operational probes

- `GET /healthz` confirms that the process and local data connection are alive.
- `GET /readyz` is deliberately **not ready** in demo mode. It becomes ready only when demo identity is disabled and approved artifact origins are configured. Use it for deployment readiness checks, not the public portfolio UI.
