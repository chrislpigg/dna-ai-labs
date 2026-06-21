# Runtime configuration contract

`LABS_DEMO_MODE=true` is the only way to start the demo runtime. Demo mode uses the seeded demo identity and SQLite implementation, is visibly labelled in the browser session, and is deliberately not ready at `/readyz`. It is appropriate only for local development or an isolated review deployment with no authoritative data.

Any deployment without `LABS_DEMO_MODE=true` is treated as production. The service does not fall back to demo identity, demo artifact origins, or SQLite in that mode. `/readyz` returns non-secret issue codes for missing configuration. Production ignores caller-supplied identity headers. OIDC bearer tokens are verified against the configured issuer, audience, and JWKS URL; portfolio, audit, and workflow mutations use the tenant-scoped PostgreSQL adapter. Each successful workflow mutation writes its audit event in the same database transaction. A database connection failure returns `DATABASE_UNAVAILABLE` and never substitutes demo data.

Never place raw member, DNA, health, family-history, employee, access-token, or production-log content in this application or its configuration.

## Required production variables

| Variable | Purpose | Value handling |
| --- | --- | --- |
| `LABS_OIDC_ISSUER` | Approved OIDC issuer used for token validation. | URL, not displayed by diagnostics. |
| `LABS_OIDC_AUDIENCE` | OIDC audience accepted by this service. | Identifier, not displayed by diagnostics. |
| `LABS_OIDC_JWKS_URL` | Approved OIDC JWKS endpoint used to verify bearer-token signatures. | HTTPS URL, not displayed by diagnostics. |
| `LABS_OIDC_CLIENT_ID` | Registered server-side OIDC client identifier. | Identifier, not displayed by diagnostics. |
| `LABS_DATABASE_URL` | Company-managed PostgreSQL connection URL. | Secret; diagnostics report only that it is missing. |
| `LABS_TENANT_ID` | Authoritative organization/tenant identifier. | Identifier, not displayed by diagnostics. |
| `LABS_TENANT_CLAIM` | Verified identity claim that carries tenant scope. | Claim name, not displayed by diagnostics. |
| `LABS_GROUP_ROLE_MAPPING` | JSON object that maps each application role to its approved, verified IdP groups. | Non-secret policy configuration; it must define every role exactly once and groups cannot be reused across roles. |
| `LABS_ALLOWED_ARTIFACT_ORIGINS` | Comma-separated HTTPS origins permitted for approved document/source/evidence links. | Origins only; each entry must be an exact HTTPS origin, such as `https://docs.company.example`. |
| `LABS_NOTIFICATION_PROVIDER` | Approved notification-provider selection. | Provider label only; provider credentials remain in the platform secret store. |
| `LABS_DIRECTORY_PROVIDER` | Approved directory-provider selection. | Provider label only. |
| `LABS_WORK_TRACKING_PROVIDER` | Approved work-tracking-provider selection. | Provider label only. |
| `LABS_CALENDAR_PROVIDER` | Approved calendar-provider selection. | Provider label only. |
| `LABS_ANALYTICS_PROVIDER` | Approved analytics-provider selection. | Provider label only. |

Provider-specific endpoints, credentials, CA material, signing keys, and client secrets must be supplied through the approved deployment secret mechanism once each adapter is implemented. Do not commit or print their values. The provider selection variables are configuration contracts; no vendor endpoint is inferred by the service.

`LABS_GROUP_ROLE_MAPPING` has this shape; replace these examples with the approved groups, never with user-controlled claims:

```json
{
  "employee": ["approved-employee-group"],
  "submitter": ["approved-submitter-group"],
  "project-lead": ["approved-project-lead-group"],
  "fellow": ["approved-fellow-group"],
  "receiving-owner": ["approved-receiving-owner-group"],
  "steering-reviewer": ["approved-steering-reviewer-group"],
  "lab-lead": ["approved-lab-lead-group"],
  "executive-sponsor": ["approved-executive-sponsor-group"],
  "platform-reviewer": ["approved-platform-reviewer-group"],
  "admin": ["approved-program-administrator-group"]
}
```

The server resolves roles only from verified OIDC group claims. An identity with no mapped group is denied; an identity matching more than one role is also denied so mappings cannot silently combine privileges. The browser can switch seeded identities only when `LABS_DEMO_MODE=true`; production ignores its demo identity header.

## Demo-only variables

| Variable | Purpose |
| --- | --- |
| `LABS_DEMO_MODE=true` | Explicitly enables seeded users, role switching, and the demo SQLite store. |
| `LABS_DB_PATH` | Optional SQLite path used only when demo mode is explicitly enabled. |

Vercel is not itself a demo-mode switch. A preview deployment is demo-only only when `LABS_DEMO_MODE=true` is explicitly set for that preview environment; otherwise it remains fail-closed.

## PostgreSQL migrations

The production schema is maintained as ordered SQL files in `migrations/`. The migration runner records each version and SHA-256 checksum in `schema_migrations`, takes a PostgreSQL advisory lock, and runs each new migration in its own transaction. A changed checksum for an already-applied migration fails closed; add a new migration rather than editing history.

Run migrations only against a company-approved PostgreSQL database, with the deployment secret mechanism supplying the URL:

```bash
LABS_DATABASE_URL='postgresql://…' npm run migrate
```

The command refuses `LABS_DEMO_MODE=true`, does not echo the URL, and never creates a SQLite fallback. The schema contains program metadata and approved-link references only, enforces append-only audit events at the database layer, and requires every authoritative workflow record (including audit events) to carry an organization scope.

### Tenant-schema migration path

Demo SQLite data is not a production migration source. Provision an empty, company-approved PostgreSQL database, run the tracked migrations, and use the authorized tenant-bootstrap path to create the organization identified by `LABS_TENANT_ID` before serving requests. Do not export, copy, or relabel seeded demo users, projects, decisions, or audit records.

The organization-scope migration deliberately stops if the earlier production schema contains any workflow rows, because it cannot safely infer an organization for those records. Treat that failure as a deployment blocker: provision a clean database or obtain an approved, separately reviewed data-migration plan with explicit tenant assignments. Do not bypass the check or assign a catch-all tenant.

This command creates the schema; it does not make the production HTTP runtime ready until the required production adapters are configured. The PostgreSQL workflow adapter resolves the verified OIDC subject against `users.subject_ref` within `LABS_TENANT_ID`; every portfolio, evidence, review, decision, handoff, and audit query includes that tenant scope. It commits the workflow change and durable audit row together, or rolls both back.

## Diagnostics

`GET /readyz` returns only stable issue codes such as `missing_database_url`, `invalid_oidc_jwks_url`, `invalid_approved_artifact_origins`, `demo_mode_enabled`, or `database_unavailable`. It never echoes environment values or secrets. Treat a `503` response as a deployment blocker.
