CREATE TABLE IF NOT EXISTS fellow_assignments (
  id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  fellow_id TEXT NOT NULL,
  assignment_role TEXT NOT NULL,
  capacity_units INTEGER NOT NULL DEFAULT 1 CHECK (capacity_units BETWEEN 1 AND 10),
  status TEXT NOT NULL DEFAULT 'proposed',
  manager_id TEXT NOT NULL,
  manager_acknowledged_at TIMESTAMPTZ,
  manager_acknowledged_by TEXT,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (organization_id, id),
  CONSTRAINT fellow_assignments_status_check CHECK (status IN ('proposed', 'active', 'completed', 'cancelled')),
  CONSTRAINT fellow_assignments_cycle_organization_fk FOREIGN KEY (cycle_id, organization_id) REFERENCES cycles(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT fellow_assignments_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT fellow_assignments_fellow_organization_fk FOREIGN KEY (fellow_id, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT fellow_assignments_manager_organization_fk FOREIGN KEY (manager_id, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT fellow_assignments_manager_ack_by_organization_fk FOREIGN KEY (manager_acknowledged_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT fellow_assignments_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT fellow_assignments_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT fellow_assignments_active_manager_ack CHECK (status <> 'active' OR manager_acknowledged_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fellow_assignments_cycle_project_idx ON fellow_assignments (organization_id, cycle_id, project_id);
CREATE INDEX IF NOT EXISTS fellow_assignments_fellow_status_idx ON fellow_assignments (organization_id, fellow_id, status);
