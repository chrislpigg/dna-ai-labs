CREATE TABLE IF NOT EXISTS integration_attempts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  project_id TEXT,
  entity_type TEXT,
  actor_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT integration_attempts_type_check CHECK (integration_type IN ('artifact', 'work_tracking', 'calendar')),
  CONSTRAINT integration_attempts_outcome_check CHECK (outcome IN ('success', 'failure', 'timeout'))
);

CREATE INDEX IF NOT EXISTS integration_attempts_health_idx ON integration_attempts (organization_id, integration_type, occurred_at DESC);
