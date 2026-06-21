# Runtime configuration contract

`LABS_DEMO_MODE=true` is the only way to start the demo runtime. Demo mode uses the seeded demo identity and SQLite implementation, is visibly labelled in the browser session, and is deliberately not ready at `/readyz`. It is appropriate only for local development or an isolated review deployment with no authoritative data.

Any deployment without `LABS_DEMO_MODE=true` is treated as production. The service does not fall back to demo identity, demo artifact origins, or SQLite in that mode. `/readyz` returns non-secret issue codes for missing configuration. The currently available runtime remains fail-closed in production until the OIDC and PostgreSQL adapters are delivered in later stories.

Never place raw member, DNA, health, family-history, employee, access-token, or production-log content in this application or its configuration.

## Required production variables

| Variable | Purpose | Value handling |
| --- | --- | --- |
| `LABS_OIDC_ISSUER` | Approved OIDC issuer used for token validation. | URL, not displayed by diagnostics. |
| `LABS_OIDC_AUDIENCE` | OIDC audience accepted by this service. | Identifier, not displayed by diagnostics. |
| `LABS_OIDC_CLIENT_ID` | Registered server-side OIDC client identifier. | Identifier, not displayed by diagnostics. |
| `LABS_DATABASE_URL` | Company-managed PostgreSQL connection URL. | Secret; diagnostics report only that it is missing. |
| `LABS_TENANT_ID` | Authoritative organization/tenant identifier. | Identifier, not displayed by diagnostics. |
| `LABS_TENANT_CLAIM` | Verified identity claim that carries tenant scope. | Claim name, not displayed by diagnostics. |
| `LABS_ALLOWED_ARTIFACT_ORIGINS` | Comma-separated HTTPS origins permitted for approved document/source/evidence links. | Origins only; each entry must be an exact HTTPS origin, such as `https://docs.company.example`. |
| `LABS_NOTIFICATION_PROVIDER` | Approved notification-provider selection. | Provider label only; provider credentials remain in the platform secret store. |
| `LABS_DIRECTORY_PROVIDER` | Approved directory-provider selection. | Provider label only. |
| `LABS_WORK_TRACKING_PROVIDER` | Approved work-tracking-provider selection. | Provider label only. |
| `LABS_CALENDAR_PROVIDER` | Approved calendar-provider selection. | Provider label only. |
| `LABS_ANALYTICS_PROVIDER` | Approved analytics-provider selection. | Provider label only. |

Provider-specific endpoints, credentials, CA material, signing keys, and client secrets must be supplied through the approved deployment secret mechanism once each adapter is implemented. Do not commit or print their values. The provider selection variables are configuration contracts; no vendor endpoint is inferred by the service.

## Demo-only variables

| Variable | Purpose |
| --- | --- |
| `LABS_DEMO_MODE=true` | Explicitly enables seeded users, role switching, and the demo SQLite store. |
| `LABS_DB_PATH` | Optional SQLite path used only when demo mode is explicitly enabled. |

Vercel is not itself a demo-mode switch. A preview deployment is demo-only only when `LABS_DEMO_MODE=true` is explicitly set for that preview environment; otherwise it remains fail-closed.

## Diagnostics

`GET /readyz` returns only stable issue codes such as `missing_database_url`, `invalid_approved_artifact_origins`, `demo_mode_enabled`, or `production_adapters_unavailable`. It never echoes environment values or secrets. Treat a `503` response as a deployment blocker.
