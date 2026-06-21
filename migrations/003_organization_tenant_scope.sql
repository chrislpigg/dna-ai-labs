-- Production tenant isolation. This migration intentionally refuses to assign
-- a tenant to existing rows: an operator must provision a clean production
-- database rather than copy or relabel demo data as authoritative data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users)
    OR EXISTS (SELECT 1 FROM cycles)
    OR EXISTS (SELECT 1 FROM projects)
    OR EXISTS (SELECT 1 FROM project_gates)
    OR EXISTS (SELECT 1 FROM evidence_entries)
    OR EXISTS (SELECT 1 FROM project_reviews)
    OR EXISTS (SELECT 1 FROM decisions)
    OR EXISTS (SELECT 1 FROM approvals)
    OR EXISTS (SELECT 1 FROM handoffs)
    OR EXISTS (SELECT 1 FROM audit_events) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Cannot add tenant scope to a populated pre-production schema. Provision an empty production database; do not copy demo data.';
  END IF;
END;
$$;

-- An organization is an opaque tenant reference. It carries no directory or
-- member-profile content.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN organization_id TEXT;
ALTER TABLE cycles ADD COLUMN organization_id TEXT;
ALTER TABLE projects ADD COLUMN organization_id TEXT;
ALTER TABLE project_gates ADD COLUMN organization_id TEXT;
ALTER TABLE evidence_entries ADD COLUMN organization_id TEXT;
ALTER TABLE project_reviews ADD COLUMN organization_id TEXT;
ALTER TABLE decisions ADD COLUMN organization_id TEXT;
ALTER TABLE approvals ADD COLUMN organization_id TEXT;
ALTER TABLE handoffs ADD COLUMN organization_id TEXT;
ALTER TABLE audit_events ADD COLUMN organization_id TEXT;

ALTER TABLE users ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE cycles ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE project_gates ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE evidence_entries ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE project_reviews ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE decisions ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE approvals ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE handoffs ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE audit_events ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE cycles
  ADD CONSTRAINT cycles_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE projects
  ADD CONSTRAINT projects_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE project_gates
  ADD CONSTRAINT project_gates_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE evidence_entries
  ADD CONSTRAINT evidence_entries_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE project_reviews
  ADD CONSTRAINT project_reviews_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE decisions
  ADD CONSTRAINT decisions_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE approvals
  ADD CONSTRAINT approvals_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE handoffs
  ADD CONSTRAINT handoffs_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_organization_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT;

-- A directory subject can belong to more than one organization, but all
-- workflow references must identify the same organization as their parent.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subject_ref_key;
ALTER TABLE users
  ADD CONSTRAINT users_organization_subject_unique UNIQUE (organization_id, subject_ref),
  ADD CONSTRAINT users_id_organization_unique UNIQUE (id, organization_id);
ALTER TABLE cycles ADD CONSTRAINT cycles_id_organization_unique UNIQUE (id, organization_id);
ALTER TABLE projects ADD CONSTRAINT projects_id_organization_unique UNIQUE (id, organization_id);
ALTER TABLE decisions ADD CONSTRAINT decisions_id_organization_unique UNIQUE (id, organization_id);

ALTER TABLE cycles
  ADD CONSTRAINT cycles_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT cycles_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE projects
  ADD CONSTRAINT projects_cycle_organization_fk FOREIGN KEY (cycle_id, organization_id) REFERENCES cycles(id, organization_id),
  ADD CONSTRAINT projects_metric_owner_organization_fk FOREIGN KEY (metric_owner_id, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT projects_sponsor_organization_fk FOREIGN KEY (sponsor_id, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT projects_receiving_owner_organization_fk FOREIGN KEY (receiving_owner_id, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT projects_project_lead_organization_fk FOREIGN KEY (project_lead_id, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT projects_adoption_acknowledged_by_organization_fk FOREIGN KEY (adoption_acknowledged_by, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT projects_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT projects_updated_by_organization_fk FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE project_gates
  ADD CONSTRAINT project_gates_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  ADD CONSTRAINT project_gates_completed_by_organization_fk FOREIGN KEY (completed_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE evidence_entries
  ADD CONSTRAINT evidence_entries_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  ADD CONSTRAINT evidence_entries_created_by_organization_fk FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE project_reviews
  ADD CONSTRAINT project_reviews_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  ADD CONSTRAINT project_reviews_completed_by_organization_fk FOREIGN KEY (completed_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE decisions
  ADD CONSTRAINT decisions_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  ADD CONSTRAINT decisions_requested_by_organization_fk FOREIGN KEY (requested_by, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT decisions_finalized_by_organization_fk FOREIGN KEY (finalized_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE approvals
  ADD CONSTRAINT approvals_decision_organization_fk FOREIGN KEY (decision_id, organization_id) REFERENCES decisions(id, organization_id),
  ADD CONSTRAINT approvals_approver_organization_fk FOREIGN KEY (approver_id, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE handoffs
  ADD CONSTRAINT handoffs_project_organization_fk FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id),
  ADD CONSTRAINT handoffs_receiving_owner_organization_fk FOREIGN KEY (receiving_owner_id, organization_id) REFERENCES users(id, organization_id),
  ADD CONSTRAINT handoffs_accepted_by_organization_fk FOREIGN KEY (accepted_by, organization_id) REFERENCES users(id, organization_id);
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_actor_organization_fk FOREIGN KEY (actor_id, organization_id) REFERENCES users(id, organization_id);

-- Tenant-prefixed indexes keep all production query paths scoped before they
-- sort or filter workflow data.
DROP INDEX IF EXISTS projects_stage_updated_idx;
DROP INDEX IF EXISTS evidence_entries_project_observed_idx;
DROP INDEX IF EXISTS audit_events_created_idx;
DROP INDEX IF EXISTS decisions_one_open_per_project;
CREATE INDEX cycles_organization_status_dates_idx ON cycles (organization_id, status, starts_on, ends_on);
CREATE INDEX projects_organization_stage_updated_idx ON projects (organization_id, stage, updated_at DESC);
CREATE INDEX evidence_entries_organization_project_observed_idx ON evidence_entries (organization_id, project_id, observed_at DESC);
CREATE INDEX audit_events_organization_created_idx ON audit_events (organization_id, created_at DESC);
CREATE UNIQUE INDEX decisions_one_open_per_organization_project
  ON decisions (organization_id, project_id)
  WHERE status IN ('requested', 'approved');
