CREATE TABLE IF NOT EXISTS project_work_items (
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  external_url TEXT,
  external_status TEXT NOT NULL DEFAULT 'unknown',
  last_verified_at TIMESTAMPTZ NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, project_id),
  CONSTRAINT project_work_items_status_check CHECK (external_status IN ('unknown', 'not_started', 'in_progress', 'blocked', 'done')),
  CONSTRAINT project_work_items_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT project_work_items_linked_by_organization_fk FOREIGN KEY (linked_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT project_work_items_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS project_work_items_status_idx ON project_work_items (organization_id, external_status, last_verified_at);
