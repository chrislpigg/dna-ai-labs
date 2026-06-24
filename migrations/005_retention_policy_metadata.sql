-- Final decisions and append-only audit events are retained for at least seven
-- years. Retention is computed by the service, never supplied by a client.
ALTER TABLE decisions ADD COLUMN retention_classification TEXT;
ALTER TABLE decisions ADD COLUMN retention_until TIMESTAMPTZ;
ALTER TABLE audit_events ADD COLUMN retention_classification TEXT NOT NULL DEFAULT 'program_record';
ALTER TABLE audit_events ADD COLUMN retention_until TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 years');
CREATE INDEX decisions_retention_idx ON decisions (organization_id, retention_until);
CREATE INDEX audit_events_retention_idx ON audit_events (organization_id, retention_until);
