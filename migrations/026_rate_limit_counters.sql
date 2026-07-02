CREATE TABLE IF NOT EXISTS rate_limit_counters (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, actor_id, route_key, window_start),
  CONSTRAINT rate_limit_counters_actor_organization_fk FOREIGN KEY (actor_id, organization_id) REFERENCES users(id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS rate_limit_counters_expiry_idx ON rate_limit_counters (expires_at);
