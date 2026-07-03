# Pilot Readiness Checklist

Use this checklist for the limited production pilot go/no-go review. Store completed checklist evidence in the approved operations system. This repository records the required checklist only; do not add personal contacts, secrets, raw production logs, member data, DNA data, health data, family-history data, employee data, access tokens, or unapproved artifacts here.

## Go/No-Go Rule

The pilot is `go` only when every required approval lane is complete, required configuration is present, required integrations are either configured or explicitly disabled by approved feature flag, and every launch-blocking SPEC scenario has current evidence. Any missing approval, absent production secret/configuration, invalid readiness response, failed audit-integrity check, failed restore evidence, or unresolved high-severity security/privacy/accessibility issue is `no-go`.

## Required Approvals

| Approval lane | Required evidence | Launch blocker |
| --- | --- | --- |
| Security | Threat model, API security regression results, tenant/role isolation evidence, audit-integrity verification, rate-limit evidence, and no unmitigated high-risk finding without written risk acceptance | Any unresolved critical/high security finding, invalid audit chain, or unapproved identity/tenant configuration |
| Privacy | Privacy impact assessment, metadata-only data-flow confirmation, retention posture, approved artifact-link boundary, and confirmation that raw member/DNA/health/family-history/employee data is not stored | Any required privacy review incomplete or any planned sensitive source-data storage in the command center |
| Accessibility | Automated accessibility regression results plus manual keyboard and screen-reader validation for intake, decision, and review flows using `docs/accessibility-validation.md` | Any high-severity WCAG 2.2 AA blocker in the pilot workflow |
| Operations | Production operations runbook review, backup/restore evidence, audit-integrity verification, readiness probe, deployment/rollback owner confirmation, dependency outage plan, and support model | Any missing runbook, failed restore test, failed `/readyz`, or unsupported dependency owner |
| Sponsor | Program sponsor approval of pilot scope, success metrics, steering cadence, launch communication, and go/no-go decision | Sponsor approval absent or success metrics not approved |
| Receiving owner | Receiving-owner cohort approval of ownership expectations, handoff criteria, delivery-kit acceptance, bounded support, onboarding, and 30-day review plan | Receiving owner acceptance absent for pilot transfer/scale path |

## Required Production Configuration

Confirm the runtime configuration contract in `docs/runtime-configuration.md` before launch:

- `LABS_DEMO_MODE` absent or false for production; demo mode is never a production fallback.
- OIDC issuer, audience, JWKS URL, tenant claim, and complete group-role mapping configured.
- Tenant id configured and matches the approved organization scope.
- PostgreSQL database URL configured through the approved secret mechanism.
- Migrations current through `npm run migrate`.
- Approved artifact origins configured.
- Durable rate-limit store configured with `LABS_RATE_LIMIT_STORE=postgres`.
- Observability exporter configured through `LABS_OBSERVABILITY_EXPORTER`.
- CSRF application origin configured for any cookie-authenticated transport.
- Required deployment-platform environment variables present for the target preview or production environment.

## Required Integration Dependencies

| Dependency | Required pilot state |
| --- | --- |
| Company directory | Active person lookup for sponsor, receiving owner, metric owner, project lead, managers, and organizations configured |
| Approved artifact verifier | Document/source-control origins configured; provider failures fail closed and never complete gates |
| Notification delivery | Email/chat provider configured or explicitly disabled for pilot with approved operations exception; worker retry/dead-letter evidence available |
| Work tracking | Provider configured or feature flag disabled with approved pilot scope exception |
| Calendar/video | Decision meeting and 30-day follow-up provider configured or feature flag disabled with approved pilot scope exception |
| Analytics/metrics | Approved metric source adapter configured or pilot metrics labelled as hypotheses until verified |
| Observability | Structured request, workflow, integration, security event, and metrics export path configured |
| Backup/restore | Managed PostgreSQL backup/PITR posture confirmed and restore test evidence linked |

## Launch-Blocking SPEC Evidence

The following scenarios come from `SPEC.md` section 11 and must have current automated or approved manual evidence before launch:

1. A project lead cannot approve their own final decision.
2. A project cannot be transferred without a receiving-owner acceptance, complete/accepted gates, delivery kit, and scheduled follow-up.
3. A project cannot be extended more than once.
4. A project cannot report a validated impact without a baseline, result, source, measurement date, and measurement owner.
5. A user cannot access another organization’s restricted project or audit events.
6. Every mutation creates a durable audit event and can be restored after a tested backup recovery.
7. An employee can complete the intake and decision-review workflows using keyboard only and with a screen reader.
8. The dashboard clearly separates candidates, active projects, hypotheses, and verified outcomes.

## Required Test Evidence

- `npm test` passing on the launch commit.
- `npm run check` passing on the launch commit.
- API security regression suite passing.
- Governed workflow e2e suite passing.
- Accessibility regression suite passing plus manual validation record.
- Runtime configuration validation and `/readyz` passing in the target environment.
- `GET /api/v1/audit-events/verify` returning `valid: true`.
- Backup/restore quarterly or launch restore test evidence linked from `docs/backup-and-restore-runbook.md`.
- Operations runbook review complete using `docs/production-operations-runbook.md`.

## Decision Record

Record only metadata in the approved operations system: checklist version, release commit, target environment, approval lane status, owner roles, evidence links, unresolved exceptions with risk acceptance links, go/no-go result, decision time, and next review date.
