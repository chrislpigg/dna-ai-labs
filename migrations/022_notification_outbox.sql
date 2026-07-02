CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  related_entity_type TEXT NOT NULL,
  related_entity_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  available_at TIMESTAMPTZ NOT NULL,
  last_error_code TEXT,
  CONSTRAINT notification_outbox_state_check CHECK (state IN ('pending', 'claimed', 'sent', 'failed', 'dead_letter')),
  CONSTRAINT notification_outbox_recipient_organization_fk FOREIGN KEY (recipient_id, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox (organization_id, state, available_at, created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_related_idx ON notification_outbox (organization_id, related_entity_type, related_entity_id);
