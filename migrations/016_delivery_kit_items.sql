CREATE TABLE IF NOT EXISTS delivery_kit_items (
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started',
  owner_id TEXT,
  evidence_link TEXT,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (project_id, organization_id, item_key),
  CONSTRAINT delivery_kit_items_status_check CHECK (status IN ('not_started', 'in_progress', 'complete')),
  CONSTRAINT delivery_kit_items_key_check CHECK (item_key IN ('architecture', 'evaluation', 'operating_model', 'onboarding', 'support', 'cost', 'monitoring', 'rollback')),
  CONSTRAINT delivery_kit_items_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT delivery_kit_items_owner_organization_fk FOREIGN KEY (owner_id, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT delivery_kit_items_accepted_by_organization_fk FOREIGN KEY (accepted_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT delivery_kit_items_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS delivery_kit_items_project_idx ON delivery_kit_items (organization_id, project_id, item_key);
