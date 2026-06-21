-- DNA AI Labs production metadata schema. Do not store raw member, DNA, health,
-- family-history, employee, access-token, or production-log content in these tables.
-- Tenant isolation is deliberately introduced by its own later migration; the HTTP
-- runtime remains fail-closed until that required production work is complete.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL REFERENCES users(id),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES cycles(id),
  title TEXT NOT NULL,
  stage TEXT NOT NULL,
  origin_team TEXT NOT NULL,
  target_users TEXT NOT NULL,
  potential_reach INTEGER NOT NULL CHECK (potential_reach >= 0),
  problem TEXT NOT NULL,
  metric TEXT NOT NULL,
  baseline TEXT NOT NULL,
  target TEXT NOT NULL,
  metric_source TEXT NOT NULL,
  metric_owner_id TEXT NOT NULL REFERENCES users(id),
  sponsor_id TEXT NOT NULL REFERENCES users(id),
  receiving_owner_id TEXT REFERENCES users(id),
  project_lead_id TEXT NOT NULL REFERENCES users(id),
  risk_classification TEXT NOT NULL,
  transfer_date DATE,
  adoption_acknowledged_by TEXT REFERENCES users(id),
  adoption_acknowledged_at TIMESTAMPTZ,
  shared_platform_impact BOOLEAN NOT NULL DEFAULT false,
  extension_count INTEGER NOT NULL DEFAULT 0 CHECK (extension_count >= 0 AND extension_count <= 1),
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_gates (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  gate_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete',
  evidence_link TEXT,
  completed_by TEXT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  exception_reason TEXT,
  PRIMARY KEY (project_id, gate_key)
);

CREATE TABLE IF NOT EXISTS evidence_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  evidence_type TEXT NOT NULL,
  result TEXT NOT NULL,
  sample_size INTEGER NOT NULL CHECK (sample_size >= 1),
  confidence TEXT NOT NULL,
  source_link TEXT NOT NULL,
  observed_at DATE NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS project_reviews (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  review_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete',
  evidence_link TEXT,
  completed_by TEXT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  exception_reason TEXT,
  PRIMARY KEY (project_id, review_type)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL,
  finalized_by TEXT REFERENCES users(id),
  finalized_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_open_per_project
  ON decisions (project_id)
  WHERE status IN ('requested', 'approved');

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE RESTRICT,
  approver_id TEXT NOT NULL REFERENCES users(id),
  approver_role TEXT NOT NULL,
  result TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (decision_id, approver_role),
  UNIQUE (decision_id, approver_id)
);

CREATE TABLE IF NOT EXISTS handoffs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  receiving_owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  adoption_plan_link TEXT NOT NULL,
  support_end_date DATE NOT NULL,
  follow_up_date DATE NOT NULL,
  onboarding_acknowledged BOOLEAN NOT NULL DEFAULT false,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_summary JSONB,
  after_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_stage_updated_idx ON projects (stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS evidence_entries_project_observed_idx ON evidence_entries (project_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);
