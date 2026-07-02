CREATE TABLE IF NOT EXISTS project_calendar_events (
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  decision_id TEXT,
  provider TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  external_url TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, project_id, event_key),
  CONSTRAINT project_calendar_events_type_check CHECK (event_type IN ('decision_meeting', 'follow_up')),
  CONSTRAINT project_calendar_events_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT project_calendar_events_decision_organization_fk FOREIGN KEY (decision_id, organization_id) REFERENCES decisions(id, organization_id) ON DELETE SET NULL,
  CONSTRAINT project_calendar_events_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT project_calendar_events_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS project_calendar_events_schedule_idx ON project_calendar_events (organization_id, event_type, scheduled_for);
