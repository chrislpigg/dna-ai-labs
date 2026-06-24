-- Existing audit history requires an approved, separately controlled baseline
-- procedure. Do not fabricate a hash chain over authoritative past events.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_events) THEN
    RAISE EXCEPTION 'Cannot add audit integrity chain to populated audit history without an approved baseline procedure';
  END IF;
END $$;
ALTER TABLE audit_events ADD COLUMN audit_sequence BIGINT NOT NULL;
ALTER TABLE audit_events ADD COLUMN previous_hash TEXT NOT NULL;
ALTER TABLE audit_events ADD COLUMN event_hash TEXT NOT NULL;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_sequence_unique UNIQUE (organization_id, audit_sequence);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_previous_hash_format CHECK (previous_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE audit_events ADD CONSTRAINT audit_events_hash_format CHECK (event_hash ~ '^[a-f0-9]{64}$');
