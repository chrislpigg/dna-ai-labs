CREATE TABLE IF NOT EXISTS metric_plans (
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL DEFAULT 'primary',
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  hypothesis_label TEXT NOT NULL,
  verified_value TEXT,
  verified_at TIMESTAMPTZ,
  stale_at TIMESTAMPTZ,
  refresh_status TEXT NOT NULL DEFAULT 'hypothesis',
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (project_id, organization_id, metric_key),
  CONSTRAINT metric_plans_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT metric_plans_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT metric_plans_status_check CHECK (refresh_status IN ('hypothesis', 'verified', 'stale')),
  CONSTRAINT metric_plans_source_type_check CHECK (source_type IN ('analytics_dashboard', 'warehouse_query', 'experiment_report'))
);

CREATE INDEX IF NOT EXISTS metric_plans_refresh_idx ON metric_plans (organization_id, refresh_status, stale_at);
