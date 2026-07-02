-- Role assignments are audited application metadata separate from external group claims.
CREATE TABLE IF NOT EXISTS role_assignments (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  assigned_role TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT role_assignments_user_organization_fk FOREIGN KEY (user_id, organization_id) REFERENCES users(id, organization_id),
  CONSTRAINT role_assignments_assigned_by_organization_fk FOREIGN KEY (assigned_by, organization_id) REFERENCES users(id, organization_id)
);

CREATE INDEX IF NOT EXISTS role_assignments_organization_role_idx
  ON role_assignments (organization_id, assigned_role, active);
