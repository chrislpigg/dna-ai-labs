CREATE TABLE IF NOT EXISTS project_follow_ups (
  project_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  due_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reminder_notification_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  completed_by TEXT,
  CONSTRAINT project_follow_ups_status_check CHECK (status IN ('pending', 'completed', 'cancelled')),
  CONSTRAINT project_follow_ups_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT project_follow_ups_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT project_follow_ups_completed_by_organization_fk FOREIGN KEY (completed_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS project_follow_ups_due_idx ON project_follow_ups (organization_id, status, due_on);
