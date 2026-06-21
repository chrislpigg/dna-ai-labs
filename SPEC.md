# DNA AI Labs — Cross-Company Program & Product Specification

**Status:** Proposed implementation baseline  
**Owner:** DNA AI Labs lead (Senior Director of Engineering)  
**Executive sponsor:** Named before pilot launch  
**Last updated:** 2026-06-20

## 1. Product and Program Charter

DNA AI Labs is a sponsor-backed internal incubation program and system of record for AI-enabled capabilities that solve company-level problems, prove measurable value with real users, and transfer to a durable operating owner.

The command center is not a demo gallery or an idea board. It is the authoritative workflow for intake, selection, incubation, decision, transfer, and post-transfer measurement. Its central promise is:

> A Lab project is successful only when another team can adopt and operate it without depending on its originating builders.

### Objectives

- Create reusable internal products with measurable company impact.
- Turn AI Days into a reliable intake, learning, and adoption channel.
- Make investment and governance decisions visible, evidence-backed, authorized, and auditable.
- Strengthen engineering quality and inclusion, starting with Accessibility and UBE agents.
- Build a distributed network of Lab Fellows who bring validated patterns back to their teams.

### Non-goals

- Replace central AI, security, privacy, data, legal, procurement, or platform governance.
- Run every successful product permanently within the Lab.
- Store member DNA, health, family-history, employee, or other sensitive source data in the command center.
- Approve models, vendors, or production releases outside established company processes.

## 2. Program Operating Model

### Quarterly cycle

| Stage | Typical timing | Accountable outcome |
| --- | --- | --- |
| Discover | Weeks 1–2 | Qualified problem intake and a documented baseline plan |
| Select | Week 3 | Two or three approved projects with sponsor, adopter, metric, and risk plan |
| Incubate | Weeks 4–9 | Pilot evidence from real users and completed or actively tracked reviews |
| Decide | Week 10 | Authorized Scale, Transfer, Extend once, or Sunset decision |
| Transfer / scale | Weeks 11–12 | Accepted owner, operational handoff, adoption launch, and follow-up review |

### Steering group and decision rights

| Role | Required responsibilities | Authority |
| --- | --- | --- |
| Lab lead | Owns portfolio quality, cadence, metrics, and cross-org connection | Creates cycles, appoints project leads, recommends decisions |
| Executive sponsor | Removes organizational blockers and owns outcome accountability | Approves selection and Scale/Transfer/Sunset decisions |
| Central AI/platform representative | Aligns shared patterns, platforms, and ownership boundaries | Required reviewer for reusable platform impact |
| Rotating business/engineering leader | Grounds portfolio in current business value and adoption demand | Required reviewer for projects in their domain |
| Project lead | Delivers pilot evidence and delivery artifacts | May update project evidence; cannot approve final decisions |
| Receiving owner | Accepts operational responsibility and adoption plan | Must accept every transfer or scale handoff |
| Lab Fellow | Contributes to a project and adoption in their home team | May contribute evidence and feedback; no governance approval |

The Lab lead plus executive sponsor are required approvers for Selection, Scale, Transfer, and Sunset. The central AI/platform representative is additionally required where a project introduces a shared platform dependency or pattern. No single person can approve their own project’s final disposition.

### Project lifecycle

```text
Draft → Submitted → Triage → Selected → Incubating → Decision pending
                                              ├── Scale → Operating / 30-day review → Closed
                                              ├── Transfer → Accepted handoff / 30-day review → Closed
                                              ├── Extend once → Incubating → Decision pending
                                              └── Sunset → Learning captured → Closed
```

- **Draft:** visible only to author and collaborators.
- **Submitted:** immutable intake snapshot is available to triage reviewers.
- **Triage:** Lab lead is refining scope, evidence, and owners.
- **Selected:** selection is approved; project may consume Lab capacity.
- **Incubating:** a bounded 6–8 week pilot is active.
- **Decision pending:** pilot results are frozen for executive decision.
- **Extend once:** only one extension is allowed. The system records why evidence was insufficient, revised scope, end date, and approving sponsor.
- **Transfer:** only after receiving-owner acceptance and all transfer gates pass.
- **Scale:** only after a named operating team accepts the roadmap and funding/capacity path.
- **Sunset:** investment stops; reusable learnings and non-sensitive artifacts remain searchable.

## 3. Required Business Rules

### Intake and selection gates

An intake cannot be submitted until it has:

- Problem statement, target users, originating team, and company-level reach hypothesis.
- One primary outcome metric with baseline, target, source, and measurement owner.
- Senior sponsor and proposed receiving owner, both selected from the company directory.
- Smallest testable pilot scope, expected duration, pilot users, and dependencies.
- Data classification declaration and required review path.
- Confirmed adoption and evidence gates.

Selection additionally requires:

- Receiving owner acknowledgement that they have reviewed the proposal.
- A project score using the common rubric: company leverage, problem value, feasibility, strategic fit, reusability, evidence quality, and adoption confidence.
- Explicit capacity allocation, start/end dates, and Lab Fellow assignment or documented exception.
- No unresolved blocker that makes the 6–8 week pilot impossible.

### Decision gates

The system must prevent a final stage change until the following evidence exists.

| Decision | Required evidence |
| --- | --- |
| Scale | Pilot outcome against baseline, user evidence, accountable operating team, capacity/funding path, release/operational plan, required reviews complete or formally risk-accepted |
| Transfer | Delivery kit complete, receiving owner acceptance, support end date, onboarding completed, 30-day review scheduled, required reviews complete or formally risk-accepted |
| Extend once | Current evidence, missing proof, narrowed/revised scope, revised end date, sponsor approval, `extension_count = 0` |
| Sunset | Decision rationale, impact summary, learning artifact, disposition of code/data/access, sponsor approval |

All final decisions require: a rationale, decision meeting date, approvers, decision record, and audit event. The decision screen must show unmet gates and disable the action until they are resolved.

### Portfolio metrics

The dashboard must distinguish hypothesis from evidence.

- **Candidates:** Draft, Submitted, and Triage; excluded from active-project counts.
- **Active projects:** Selected, Incubating, Decision pending, or approved Extend once.
- **Validated reach:** teams/users with actual pilot or post-transfer usage.
- **Potential reach:** a labelled hypothesis; never combined with validated reach.
- **Adoption path named:** only projects where a directory-verified receiving owner has acknowledged the proposal.
- **Impact:** reported as baseline, target, current result, confidence, sample size, source, and measurement date.

The dashboard must never show placeholder figures as results. Projects with missing baselines are prominently marked **Measurement incomplete** and cannot advance to Decision pending.

## 4. Users, Access, and Information Handling

### Authorization model

Use the approved company SSO identity provider and group-based role assignment. Access is least privilege and enforced server-side.

| Role | Read | Create/edit | Change stage | Approve | Administer |
| --- | --- | --- | --- | --- | --- |
| Employee | Published portfolio only | Own drafts | No | No | No |
| Submitter | Own projects | Own draft/submitted intake | No | No | No |
| Project lead | Assigned projects | Project evidence/artifacts | Request decision only | No | No |
| Fellow | Assigned projects | Assigned contributions | No | No | No |
| Receiving owner | Assigned transfer | Acceptance and adoption artifacts | No | Accept handoff | No |
| Steering reviewer | Portfolio | Review comments and risk disposition | No | Selection/decision as assigned | No |
| Lab lead | Entire portfolio | Portfolio and cycle configuration | Move non-final workflow states | Required approver | Limited |
| Program administrator | Entire program | Configuration, users, retention | No unilateral final decision | No | Yes |

### Data classification and privacy

- The command center stores program metadata and links to approved internal systems only.
- It must never ingest raw member, DNA, health, family-history, employee, access-token, or production-log content.
- Intake and evidence forms include a data-classification field with permitted values: `Public`, `Internal`, `Confidential business`, `Restricted metadata`. `Restricted` requires designated privacy/security review before selection.
- Artifact uploads are disabled for the MVP. Links must point to approved company document, source-control, and evidence systems; the server validates allowed domains.
- Retention: retain audit records and final decision metadata for seven years or the company policy period, whichever is longer; apply the corporate retention policy to linked artifacts.
- All administrative access, export, decision, approval, role, and deletion actions are auditable.

### Security requirements

- Approved SSO/OIDC session, server-side authorization, CSRF protection, secure cookies, and organization-level tenancy isolation.
- Encrypt data in transit and at rest with company-managed keys.
- Content Security Policy disallowing unapproved third-party scripts, fonts, and frames; package fonts locally or use approved design-system assets.
- Validate and normalize every API input; render all user content safely; protect against stored XSS, IDOR, CSV injection, mass assignment, and open redirects.
- Rate-limit write endpoints, log security events, and send audit events to the approved observability platform.
- Perform threat modeling before build, security review before pilot, and penetration testing before broad rollout.

## 5. Product Experience Requirements

### Portfolio dashboard

The home view provides role-appropriate visibility without overstating evidence.

- Cycle selector; current stage and dates; next decision forum; capacity view.
- Counts for candidates, active projects, decision-pending projects, validated adopters, validated impact, and at-risk projects.
- Filters by lifecycle stage, cycle, theme, receiving organization, risk status, owner, and decision outcome.
- Project cards show evidence completeness, gate status, owner acknowledgement, risk status, and next action—not only a narrative description.
- Every displayed metric links to its source or shows that it is an unverified hypothesis.

### Intake

- Save draft, invite collaborators, submit, and withdraw while still in Triage.
- Directory-backed sponsor/owner fields; acknowledgements are collected in-product.
- Form validation rejects blank/whitespace values, past transfer dates, impossible pilot dates, and invalid cross-field states.
- The submitter receives notifications when triage comments, selection status, or requests for information change.
- Intake is versioned. Resubmission creates a revision; reviewers can compare changes.

### Project workspace

Each selected project contains:

- Problem, users, theory of change, metric plan, and baseline.
- Pilot plan, timeline, capacity, dependencies, and named Fellows.
- Evidence log with date, source link, method, sample, result, and confidence.
- Review tracker for security, privacy, legal/compliance, accessibility, data, and responsible AI, using only applicable review types.
- Delivery kit for architecture, evaluation, operating model, onboarding, support boundary, cost/usage, monitoring, and incident/rollback ownership.
- Decision record, approval requests, immutable decision history, and post-transfer follow-up.

### Notifications and integrations

- Company directory: resolve people, organizations, managers, and active status.
- Internal work-tracking system: create/link delivery work and surface status; no duplicate project management system.
- Approved document and source-control systems: verified artifact links and change evidence.
- Calendar/video system: decision meeting and 30-day review links.
- Internal analytics/observability: approved metric sources and scheduled metric refresh.
- Email/chat notifications: intake submitted, acknowledgement requested, review blocked, decision ready, approval requested, handoff accepted, and 30-day review due.

## 6. Data Model

The production service uses a relational database. All records have `id`, `created_at`, `created_by`, `updated_at`, `updated_by`, and organization/tenant scope; all deletions are soft deletes unless retention policy requires otherwise.

| Entity | Key fields |
| --- | --- |
| `cycle` | theme, quarter, dates, capacity, steering group, status |
| `project` | title, summary, lifecycle state, cycle, theme, origin team, project lead, sponsor, receiving owner, risk level, extension count |
| `intake_revision` | submitted content snapshot, author, revision number, submission status |
| `metric_plan` | metric definition, baseline, target, unit, source, measurement owner, evidence-complete flag |
| `evidence_entry` | project, date, type, source link, result, sample size, confidence, author |
| `gate` | project, gate type, state, evidence link, reviewer, completed date, exception rationale |
| `review` | project, review type, required state, approval/exception, owner, linked system record |
| `delivery_kit_item` | project, item type, owner, status, evidence link, accepted date |
| `decision` | project, proposed outcome, rationale, meeting date, requester, final state, immutable result |
| `approval` | decision, approver, role, result, timestamp, comment |
| `handoff` | project, receiving owner, support end date, onboarding completion, adoption plan, 30-day review |
| `fellow_assignment` | cycle, project, fellow, manager acknowledgement, role, outcome |
| `notification` | recipient, type, delivery state, related entity, timestamp |
| `audit_event` | actor, action, entity, before/after summary, IP/device metadata as policy permits, timestamp |

## 7. APIs and Integration Contracts

All APIs are versioned under `/api/v1`, use company SSO tokens, enforce authorization on every request, and return structured error codes. Web clients do not write directly to the database.

| Capability | Endpoint / contract | Key rules |
| --- | --- | --- |
| Portfolio | `GET /cycles`, `GET /projects` | Enforces visibility and supports filter/pagination |
| Draft/intake | `POST /intakes`, `PATCH /intakes/{id}`, `POST /intakes/{id}/submit` | Server validates selection-gate data and creates revisions |
| Selection | `POST /projects/{id}/select` | Requires authorized approvals and capacity assignment |
| Evidence | `POST /projects/{id}/evidence` | Requires approved-link domain and evidence schema |
| Reviews/gates | `PATCH /projects/{id}/gates/{gate}` | Only designated reviewers may satisfy or exception a gate |
| Decisions | `POST /projects/{id}/decision-requests`, `POST /decisions/{id}/approvals`, `POST /decisions/{id}/finalize` | Finalize verifies all required gates and segregation of duties |
| Handoffs | `POST /projects/{id}/handoff/accept` | Receiving owner accepts; creates follow-up review |
| Metrics | `GET /portfolio/metrics`, `POST /projects/{id}/metrics/refresh` | Separates potential and validated impact |
| Admin | `POST /cycles`, `PATCH /roles`, `GET /audit-events` | Restricted to program administrators |

Every mutation emits an `audit_event` and, where relevant, an approved notification event. A decision finalization is idempotent and cannot be edited; correction requires a linked superseding decision.

## 8. Technical Architecture

### Required components

- **Web application:** accessible internal UI using the company-supported TypeScript web stack and design system.
- **Application API:** server-side business rules, authorization, workflow engine, audit logging, and integration adapters.
- **Relational store:** company-approved managed database for transactional program data.
- **Identity/authorization:** company SSO and group/attribute-based access control.
- **Integration workers:** directory sync, notification delivery, metric refresh, and work-tracking/document link verification.
- **Observability:** structured logs, traces, security events, application metrics, and audit-export capability.

### Architecture decisions

- Local storage is allowed only for non-authoritative UI preferences. It must never contain project, decision, access, or audit data.
- The existing static prototype becomes a design reference only; it is not migrated as a production runtime.
- Use server-enforced lifecycle transitions. The client can request a transition but cannot set arbitrary project state.
- Store evidence metadata and approved links, not unbounded documents or sensitive raw inputs.
- Use feature flags for pilot cohort access, integrations, and workflow changes.

## 9. Quality, Accessibility, and Reliability

### Non-functional requirements

- WCAG 2.2 AA: keyboard-complete flows, visible focus, semantic forms, error summaries, screen-reader announcements, contrast, reduced-motion support, and no color-only status meaning.
- 99.9% monthly availability during business hours for the portfolio and decision workflow, excluding scheduled maintenance.
- P95 read response under 500 ms and P95 write response under 1 s for normal internal use.
- Recovery point objective of 24 hours or stricter corporate standard; recovery time objective of 4 hours or stricter standard.
- Daily backups, restoration test every quarter, and audit-log integrity monitoring.
- Responsive support for current company desktop browser standards; tablet usable for executive decision reviews.

### Error behavior

- A failed integration never silently marks a gate complete.
- Metric refresh errors preserve the last verified value, timestamp, source, and an explicit stale indicator.
- Conflicting edits use optimistic concurrency and prompt the user to merge/reload; no silent overwrite.
- Unauthorized users receive a non-sensitive error and no partial data.

## 10. Full Development Lifecycle (DLC)

### Phase 0 — Sponsor alignment and discovery

**Deliverables:** sponsor charter, RACI, approved problem statement, success metrics, stakeholder map, data classification, and current-workflow research.

**Exit gate:** executive sponsor, central AI/platform representative, privacy/security partner, and receiving-owner representatives agree to pilot scope and decision rights.

### Phase 1 — Product and service design

**Deliverables:** this specification, journey maps, low/high-fidelity prototypes, rubric, lifecycle state machine, data model, API contract, notification map, and delivery-kit template.

**Exit gate:** product/design review confirms every stated business rule has a user experience and a server-enforced rule; accessibility and governance review approve the design direction.

### Phase 2 — Architecture and risk design

**Deliverables:** architecture decision records, threat model, privacy impact assessment, data-flow diagram, retention design, integration contracts, reliability plan, and test strategy.

**Exit gate:** security, privacy, platform, and operations approvals; no unmitigated high-risk finding without written risk acceptance.

### Phase 3 — Foundation build

**Scope:** SSO/RBAC, database, audit trail, cycle/project model, draft/submission workflow, input validation, design system, feature flags, observability, and automated test harness.

**Exit gate:** role/tenant isolation, audit persistence, backup/restore, accessibility baseline, and foundational security tests pass in a non-production environment.

### Phase 4 — Governed workflow build

**Scope:** selection rubric, evidence, review/gate tracker, decision requests/approvals, immutable decision records, delivery kit, handoff acceptance, notifications, and portfolio metrics.

**Exit gate:** end-to-end scenario tests demonstrate that no unauthorized or incomplete transition can reach Scale/Transfer/Sunset.

### Phase 5 — Pilot launch

**Scope:** one Labs cycle, two initial lighthouse projects (Accessibility and UBE), a small Fellows cohort, and a limited steering group.

**Exit gate:** real users complete intake, selection, evidence, decision, and one transfer/scale path; pilot feedback and production-readiness issues are triaged.

### Phase 6 — Production launch

**Scope:** company-ready portfolio, approved integrations, training, runbooks, support model, data retention, incident response, and executive communication.

**Exit gate:** launch checklist signed by program sponsor, product/engineering owner, security/privacy, accessibility, and operations; critical test suite and restore test pass.

### Phase 7 — Operate and improve

**Cadence:** weekly operations review, biweekly portfolio review, quarterly steering decision forum, quarterly access review, quarterly restore test, and biannual threat-model/risk review.

**Measures:** transfer rate, post-transfer adoption, validated impact, time from intake to decision, extension/sunset rate, review-cycle duration, Fellow distribution, partner satisfaction, and program cost.

## 11. Test Strategy and Acceptance Criteria

| Test layer | Required coverage |
| --- | --- |
| Unit | Lifecycle transition guards, extension limit, field validation, metric calculations, segregation of duties, authorization policies |
| API/integration | SSO claims, directory lookup, work-tracking/document link validation, notifications, idempotency, stale metrics, audit-event emission |
| End-to-end | Draft → submitted → selected → incubating → decision → transfer/scale; rejection paths; owner acknowledgement; decision approval; 30-day review |
| Security | IDOR, role escalation, cross-tenant access, XSS, CSRF, injection, mass assignment, unauthorized export, audit tampering |
| Accessibility | Automated WCAG scans plus keyboard and screen-reader manual validation for intake, decision, and review workflows |
| Reliability | Concurrent edits, dependency outage, retry/idempotency, backup restore, stale integration response, feature-flag rollback |
| User acceptance | Lab lead, sponsor, project lead, receiving owner, Fellow, and central AI/platform reviewer each complete their core journey |

### Launch-blocking acceptance scenarios

1. A project lead cannot approve their own final decision.
2. A project cannot be transferred without a receiving-owner acceptance, complete/accepted gates, delivery kit, and scheduled follow-up.
3. A project cannot be extended more than once.
4. A project cannot report a validated impact without a baseline, result, source, measurement date, and measurement owner.
5. A user cannot access another organization’s restricted project or audit events.
6. Every mutation creates a durable audit event and can be restored after a tested backup recovery.
7. An employee can complete the intake and decision-review workflows using keyboard only and with a screen reader.
8. The dashboard clearly separates candidates, active projects, hypotheses, and verified outcomes.

## 12. Delivery Plan and Initial Backlog

### Release 0 — Program readiness (2–4 weeks)

- Confirm sponsor, RACI, steering group, receiving-owner cohort, standard rubric, and delivery-kit template.
- Complete workflow research with Accessibility, UBE, platform, security, privacy, and target receiving teams.
- Select internal stack, identity, database, tracking, documents, and analytics integrations through architecture decisions.

### Release 1 — Governed portfolio MVP (6–8 weeks)

- SSO/RBAC, cycle/project service, server-side workflow states, project intake, selection, project workspace, evidence, audit log, and portfolio dashboard.
- Include automated unit, API, E2E, accessibility, and security tests from day one.
- Pilot with a restricted cohort; no sensitive source-data storage.

### Release 2 — Decision and transfer control plane (4–6 weeks)

- Review/gate tracker, decision approvals, extension enforcement, delivery kit, receiving-owner acceptance, notifications, post-transfer review, and dashboard evidence distinction.

### Release 3 — Program scale and integrations (4–8 weeks)

- Directory, work-tracking, approved artifact-link, calendar, and analytics integrations; Fellows management; executive reporting; operational runbooks.

### Release 4 — Continuous improvement

- Evaluate usage and decision quality, reduce review friction, add approved metric connectors, and refine the selection rubric based on transfer/adoption outcomes.

## 13. Risks and Controls

| Risk | Control |
| --- | --- |
| Shadow-AI/platform perception | Central AI/platform role is required in steering and shared-pattern decisions; publish ownership boundaries |
| Governance becomes bureaucracy | Use lightweight, visible gates; automate evidence links and status; measure cycle time |
| Portfolio becomes a demo graveyard | Require receiving owner before selection; enforce decision and transfer gates |
| Sensitive data enters intake | Clear policy, classification field, automated warnings, restricted uploads, reviewer escalation |
| Leaders misread potential as impact | Separate candidate, hypothesis, pilot evidence, and verified adoption in every dashboard/report |
| Receiving teams reject handoffs | Require early acknowledgement, acceptance criteria, onboarding, bounded support, and 30-day review |
| Fellows lack capacity | Manager acknowledgement and capacity allocation are selection criteria |
| System loses trust | SSO, role controls, append-only audit history, backup/restore, and visible source-of-truth status |

## 14. Definition of Done

DNA AI Labs is ready for broad company use only when:

- The program has completed one pilot cycle using the governed workflow for Accessibility and UBE or comparable lighthouse projects.
- At least one capability has completed a verified, accepted transfer and 30-day adoption review.
- All launch-blocking acceptance scenarios pass in production-like testing.
- Required security, privacy, accessibility, operational, and sponsor approvals are documented.
- The command center is the shared, auditable system of record—not a per-browser prototype.
- Leadership reporting shows verified outcomes separately from hypotheses and is trusted by the steering group and receiving teams.
