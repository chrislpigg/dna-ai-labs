ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_idempotency_unique
  ON notification_outbox (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_worker_due_idx
  ON notification_outbox (organization_id, state, available_at, claim_expires_at, created_at);
