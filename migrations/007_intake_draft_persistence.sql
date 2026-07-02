-- Intake drafts are incomplete metadata records and must not enter portfolio,
-- selection, or decision queries until a later explicit submit transition.
CREATE TABLE IF NOT EXISTS intake_drafts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status = 'Draft'),
  owner_id TEXT NOT NULL,
  collaborator_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL,
  CONSTRAINT intake_drafts_owner_organization_fk FOREIGN KEY (owner_id, organization_id) REFERENCES users(id, organization_id),
  CONSTRAINT intake_drafts_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id),
  CONSTRAINT intake_drafts_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id),
  CONSTRAINT intake_drafts_collaborators_array CHECK (jsonb_typeof(collaborator_ids) = 'array'),
  CONSTRAINT intake_drafts_content_object CHECK (jsonb_typeof(content) = 'object')
);

CREATE INDEX IF NOT EXISTS intake_drafts_organization_owner_updated_idx
  ON intake_drafts (organization_id, owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS intake_drafts_organization_updated_idx
  ON intake_drafts (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS intake_drafts_collaborators_gin_idx
  ON intake_drafts USING GIN (collaborator_ids);
