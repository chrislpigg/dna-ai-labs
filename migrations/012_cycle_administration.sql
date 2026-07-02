-- Program cycles are server-administered metadata for capacity planning.
ALTER TABLE cycles ADD COLUMN capacity_units INTEGER NOT NULL DEFAULT 3 CHECK (capacity_units BETWEEN 1 AND 50);
ALTER TABLE cycles ADD COLUMN steering_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE cycles
  ADD CONSTRAINT cycles_steering_group_ids_array CHECK (jsonb_typeof(steering_group_ids) = 'array');

CREATE INDEX IF NOT EXISTS cycles_organization_status_dates_idx
  ON cycles (organization_id, status, starts_on DESC, ends_on DESC);
