-- Retain governed program records. Audit events are intentionally excluded: they
-- are append-only and never eligible for ordinary deletion.
ALTER TABLE cycles ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE cycles ADD COLUMN deleted_by TEXT;
ALTER TABLE cycles ADD COLUMN deletion_reason TEXT;
ALTER TABLE projects ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN deleted_by TEXT;
ALTER TABLE projects ADD COLUMN deletion_reason TEXT;
ALTER TABLE evidence_entries ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE evidence_entries ADD COLUMN deleted_by TEXT;
ALTER TABLE evidence_entries ADD COLUMN deletion_reason TEXT;
ALTER TABLE decisions ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN deleted_by TEXT;
ALTER TABLE decisions ADD COLUMN deletion_reason TEXT;
ALTER TABLE handoffs ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE handoffs ADD COLUMN deleted_by TEXT;
ALTER TABLE handoffs ADD COLUMN deletion_reason TEXT;

ALTER TABLE cycles ADD CONSTRAINT cycles_deleted_by_organization_fk FOREIGN KEY (deleted_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT;
ALTER TABLE projects ADD CONSTRAINT projects_deleted_by_organization_fk FOREIGN KEY (deleted_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT;
ALTER TABLE evidence_entries ADD CONSTRAINT evidence_entries_deleted_by_organization_fk FOREIGN KEY (deleted_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT;
ALTER TABLE decisions ADD CONSTRAINT decisions_deleted_by_organization_fk FOREIGN KEY (deleted_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT;
ALTER TABLE handoffs ADD CONSTRAINT handoffs_deleted_by_organization_fk FOREIGN KEY (deleted_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT;

CREATE INDEX cycles_active_organization_idx ON cycles (organization_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX projects_active_organization_idx ON projects (organization_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX evidence_entries_active_project_idx ON evidence_entries (organization_id, project_id, observed_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX decisions_active_project_idx ON decisions (organization_id, project_id, requested_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX handoffs_active_project_idx ON handoffs (organization_id, project_id) WHERE deleted_at IS NULL;
