-- Triage comments are chronological program metadata for submitted intakes.
-- They must not contain raw member, DNA, health, employee, token, or log data.
ALTER TABLE projects ADD COLUMN triage_status TEXT NOT NULL DEFAULT 'open' CHECK (triage_status IN ('open', 'information_requested'));
ALTER TABLE projects ADD COLUMN information_requested_by TEXT;
ALTER TABLE projects ADD COLUMN information_requested_at TIMESTAMPTZ;

ALTER TABLE projects
  ADD CONSTRAINT projects_information_requested_by_organization_fk FOREIGN KEY (information_requested_by, organization_id) REFERENCES users(id, organization_id);

CREATE TABLE IF NOT EXISTS project_triage_comments (
  id TEXT PRIMARY KEY,
  comment_sequence BIGSERIAL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  comment_kind TEXT NOT NULL DEFAULT 'comment' CHECK (comment_kind IN ('comment', 'request_for_information')),
  comment_text TEXT NOT NULL CHECK (char_length(comment_text) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT project_triage_comments_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT project_triage_comments_author_organization_fk FOREIGN KEY (author_id, organization_id) REFERENCES users(id, organization_id)
);

CREATE INDEX IF NOT EXISTS project_triage_comments_organization_project_created_idx
  ON project_triage_comments (organization_id, project_id, created_at, comment_sequence);

CREATE INDEX IF NOT EXISTS projects_organization_triage_status_idx
  ON projects (organization_id, triage_status, updated_at DESC);
