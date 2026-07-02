-- Project capacity units are governed metadata used by selection.
ALTER TABLE projects ADD COLUMN capacity_units INTEGER NOT NULL DEFAULT 1 CHECK (capacity_units BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS projects_organization_cycle_capacity_idx
  ON projects (organization_id, cycle_id, stage, deleted_at);
