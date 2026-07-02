-- Draft collaborators are explicit metadata records with draft-level
-- permissions. Directory validation is added by a later integration story.
CREATE TABLE IF NOT EXISTS intake_draft_collaborators (
  draft_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  collaborator_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'edit' CHECK (permission = 'edit'),
  added_at TIMESTAMPTZ NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (draft_id, collaborator_id),
  CONSTRAINT intake_draft_collaborators_draft_fk FOREIGN KEY (draft_id) REFERENCES intake_drafts(id) ON DELETE CASCADE,
  CONSTRAINT intake_draft_collaborators_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT intake_draft_collaborators_user_organization_fk FOREIGN KEY (collaborator_id, organization_id) REFERENCES users(id, organization_id),
  CONSTRAINT intake_draft_collaborators_added_by_organization_fk FOREIGN KEY (added_by, organization_id) REFERENCES users(id, organization_id)
);

CREATE INDEX IF NOT EXISTS intake_draft_collaborators_organization_user_idx
  ON intake_draft_collaborators (organization_id, collaborator_id, draft_id);
