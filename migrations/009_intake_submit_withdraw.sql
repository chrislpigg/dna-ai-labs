-- Explicit draft submission moves a draft to Submitted while creating the
-- authoritative submitted project in the same application transaction.
ALTER TABLE intake_drafts DROP CONSTRAINT IF EXISTS intake_drafts_status_check;
ALTER TABLE intake_drafts ADD CONSTRAINT intake_drafts_status_check CHECK (status IN ('Draft', 'Submitted'));

CREATE INDEX IF NOT EXISTS intake_drafts_organization_status_updated_idx
  ON intake_drafts (organization_id, status, updated_at DESC);
