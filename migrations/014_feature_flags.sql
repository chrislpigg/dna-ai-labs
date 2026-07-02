-- Feature flags are tenant-scoped controls for pilot workflow and integration surfaces.
CREATE TABLE IF NOT EXISTS feature_flags (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  flag_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (organization_id, flag_key),
  CONSTRAINT feature_flags_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id)
);

CREATE INDEX IF NOT EXISTS feature_flags_organization_enabled_idx
  ON feature_flags (organization_id, enabled, flag_key);
