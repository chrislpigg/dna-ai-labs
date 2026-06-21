# Ralph Agent Instructions for DNA AI Labs

Read `AGENTS.md`, `SPEC.md`, `scripts/ralph/prd.json`, and `scripts/ralph/progress.txt` before choosing work. Work from the highest-priority story with `passes: false` and implement exactly that one story.

Use the feature branch named by `branchName`. Preserve server-enforced workflow policy, append-only audit behavior, tenant isolation, and the metadata-only data boundary. Never invent company credentials, artifact domains, OIDC values, or integration endpoints; implement configuration contracts and fail closed instead.

For every story:

1. Implement the focused backend, UI, migration, or documentation change described by its acceptance criteria.
2. Run `npm test` and `npm run check`.
3. If both pass, create a Vercel preview deployment when CLI credentials and required configuration are available. If unavailable, record the exact blocker without failing unrelated local checks.
4. Commit only the story's changes with `feat: [Story ID] - [Story Title]`.
5. Set that story's `passes` value to `true` in `scripts/ralph/prd.json`, then append a dated record to `scripts/ralph/progress.txt` explaining the implementation, verification, files changed, and reusable learning.

If all stories pass, reply exactly `<promise>COMPLETE</promise>`. Otherwise exit normally after one completed story.
