ALTER TABLE project_gates
  ADD COLUMN IF NOT EXISTS artifact_verification_status TEXT CHECK (artifact_verification_status IS NULL OR artifact_verification_status IN ('verified'));
ALTER TABLE project_gates ADD COLUMN IF NOT EXISTS artifact_verified_at TIMESTAMPTZ;
ALTER TABLE project_gates ADD COLUMN IF NOT EXISTS artifact_verification_method TEXT;

ALTER TABLE evidence_entries
  ADD COLUMN IF NOT EXISTS artifact_verification_status TEXT CHECK (artifact_verification_status IS NULL OR artifact_verification_status IN ('verified'));
ALTER TABLE evidence_entries ADD COLUMN IF NOT EXISTS artifact_verified_at TIMESTAMPTZ;
ALTER TABLE evidence_entries ADD COLUMN IF NOT EXISTS artifact_verification_method TEXT;

ALTER TABLE project_reviews
  ADD COLUMN IF NOT EXISTS artifact_verification_status TEXT CHECK (artifact_verification_status IS NULL OR artifact_verification_status IN ('verified'));
ALTER TABLE project_reviews ADD COLUMN IF NOT EXISTS artifact_verified_at TIMESTAMPTZ;
ALTER TABLE project_reviews ADD COLUMN IF NOT EXISTS artifact_verification_method TEXT;

ALTER TABLE delivery_kit_items
  ADD COLUMN IF NOT EXISTS artifact_verification_status TEXT CHECK (artifact_verification_status IS NULL OR artifact_verification_status IN ('verified'));
ALTER TABLE delivery_kit_items ADD COLUMN IF NOT EXISTS artifact_verified_at TIMESTAMPTZ;
ALTER TABLE delivery_kit_items ADD COLUMN IF NOT EXISTS artifact_verification_method TEXT;

ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS artifact_verification_status TEXT CHECK (artifact_verification_status IS NULL OR artifact_verification_status IN ('verified'));
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS artifact_verified_at TIMESTAMPTZ;
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS artifact_verification_method TEXT;
