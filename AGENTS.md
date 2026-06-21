# DNA AI Labs Command Center

## Delivery rules

- `SPEC.md` is the product source of truth; this application remains metadata-and-approved-links only.
- Never store raw member, DNA, health, family-history, employee, access-token, or production-log content.
- Authorization, tenant scope, and lifecycle state transitions are server-owned. Every mutation needs a durable audit event.
- The current SQLite implementation is demo-only. Production paths must fail closed when required OIDC or database configuration is absent.
- Preserve the existing workflow tests while adding targeted tests for each new behavior.

## Quality gate

Run `npm test` and `npm run check`. Run a Vercel preview deployment only after both pass; report configuration-dependent deployment blockers rather than inventing secrets.

## Ralph workflow

Read `scripts/ralph/prd.json` and `scripts/ralph/progress.txt`. Implement exactly one highest-priority unfinished story per iteration, commit it, mark it complete, and append a concise progress record.
