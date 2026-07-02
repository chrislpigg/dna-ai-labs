-- Submitted intake revisions are immutable metadata snapshots for reviewer comparison.
-- Snapshot content is limited to approved intake fields and must not include raw member,
-- DNA, health, employee, token, or production-log content.
CREATE TABLE IF NOT EXISTS intake_revisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT intake_revisions_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT intake_revisions_submitter_organization_fk FOREIGN KEY (submitted_by, organization_id) REFERENCES users(id, organization_id),
  CONSTRAINT intake_revisions_project_number_unique UNIQUE (project_id, organization_id, revision_number)
);

CREATE INDEX IF NOT EXISTS intake_revisions_organization_project_number_idx
  ON intake_revisions (organization_id, project_id, revision_number);
