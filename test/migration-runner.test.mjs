import test from "node:test";
import assert from "node:assert/strict";
import { loadSqlMigrations, runMigrations } from "../src/migration-runner.mjs";

class FakePostgresClient {
  constructor({ applied = [], failSql = null } = {}) {
    this.applied = new Map(applied.map(row => [row.version, row.checksum]));
    this.failSql = failSql;
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.startsWith("SELECT version, checksum")) return { rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) };
    if (sql === this.failSql) throw new Error("migration execution failed");
    if (sql.startsWith("INSERT INTO schema_migrations")) this.applied.set(params[0], params[1]);
    return { rows: [] };
  }
}

test("repository migrations are ordered and include the current core schema", () => {
  const migrations = loadSqlMigrations();
  assert.deepEqual(migrations.map(migration => migration.version), ["001_core_schema", "002_audit_events_append_only", "003_organization_tenant_scope", "004_soft_delete_lifecycle", "005_retention_policy_metadata", "006_audit_integrity_chain", "007_intake_draft_persistence", "008_intake_draft_collaborators", "009_intake_submit_withdraw"]);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS projects/);
  assert.match(migrations[0].sql, /CREATE TABLE IF NOT EXISTS audit_events/);
  assert.match(migrations[1].sql, /append-only/);
});

test("intake submit migration allows submitted draft status for explicit transitions", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "009_intake_submit_withdraw");
  assert.ok(migration);
  assert.match(migration.sql, /DROP CONSTRAINT IF EXISTS intake_drafts_status_check/);
  assert.match(migration.sql, /CHECK \(status IN \('Draft', 'Submitted'\)\)/);
  assert.match(migration.sql, /intake_drafts_organization_status_updated_idx/);
});

test("intake draft collaborator migration records explicit draft permissions", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "008_intake_draft_collaborators");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS intake_draft_collaborators/);
  assert.match(migration.sql, /permission TEXT NOT NULL DEFAULT 'edit' CHECK \(permission = 'edit'\)/);
  assert.match(migration.sql, /PRIMARY KEY \(draft_id, collaborator_id\)/);
  assert.match(migration.sql, /intake_draft_collaborators_user_organization_fk FOREIGN KEY \(collaborator_id, organization_id\) REFERENCES users\(id, organization_id\)/);
  assert.match(migration.sql, /intake_draft_collaborators_organization_user_idx/);
});

test("intake draft migration keeps incomplete drafts tenant-scoped outside submitted projects", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "007_intake_draft_persistence");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS intake_drafts/);
  assert.match(migration.sql, /organization_id TEXT NOT NULL REFERENCES organizations\(id\)/);
  assert.match(migration.sql, /status TEXT NOT NULL DEFAULT 'Draft' CHECK \(status = 'Draft'\)/);
  assert.match(migration.sql, /collaborator_ids JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(migration.sql, /content JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(migration.sql, /intake_drafts_owner_organization_fk FOREIGN KEY \(owner_id, organization_id\) REFERENCES users\(id, organization_id\)/);
  assert.doesNotMatch(migration.sql, /ALTER TABLE projects ADD COLUMN .*draft/i);
});

test("soft-delete migration retains governed records and never soft-deletes audit events", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "004_soft_delete_lifecycle");
  assert.ok(migration);
  for (const table of ["cycles", "projects", "evidence_entries", "decisions", "handoffs"]) {
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN deleted_at TIMESTAMPTZ;`));
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN deleted_by TEXT;`));
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN deletion_reason TEXT;`));
  }
  assert.doesNotMatch(migration.sql, /ALTER TABLE audit_events ADD COLUMN deleted_at/i);
});

test("retention migration records seven-year policy metadata for final decisions and audit events", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "005_retention_policy_metadata");
  assert.ok(migration);
  assert.match(migration.sql, /ALTER TABLE decisions ADD COLUMN retention_classification TEXT/);
  assert.match(migration.sql, /ALTER TABLE decisions ADD COLUMN retention_until TIMESTAMPTZ/);
  assert.match(migration.sql, /ALTER TABLE audit_events ADD COLUMN retention_classification TEXT NOT NULL DEFAULT 'program_record'/);
  assert.match(migration.sql, /INTERVAL '7 years'/);
});

test("audit integrity migration adds a tenant-scoped hash chain", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "006_audit_integrity_chain");
  assert.ok(migration);
  assert.match(migration.sql, /audit_sequence BIGINT NOT NULL/);
  assert.match(migration.sql, /previous_hash TEXT NOT NULL/);
  assert.match(migration.sql, /event_hash TEXT NOT NULL/);
  assert.match(migration.sql, /audit_events_sequence_unique UNIQUE \(organization_id, audit_sequence\)/);
});

test("tenant-scope migration makes each core record organization-bound", () => {
  const migration = loadSqlMigrations().find(entry => entry.version === "003_organization_tenant_scope");
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS organizations/);

  for (const table of ["users", "cycles", "projects", "project_gates", "evidence_entries", "project_reviews", "decisions", "approvals", "handoffs", "audit_events"]) {
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN organization_id TEXT;`));
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table} ALTER COLUMN organization_id SET NOT NULL;`));
    assert.match(migration.sql, new RegExp(`ALTER TABLE ${table}\\n  ADD CONSTRAINT ${table}_organization_fk FOREIGN KEY \\(organization_id\\) REFERENCES organizations\\(id\\)`));
  }

  assert.match(migration.sql, /projects_cycle_organization_fk FOREIGN KEY \(cycle_id, organization_id\) REFERENCES cycles\(id, organization_id\)/);
  assert.match(migration.sql, /audit_events_actor_organization_fk FOREIGN KEY \(actor_id, organization_id\) REFERENCES users\(id, organization_id\)/);
  assert.match(migration.sql, /audit_events_organization_created_idx ON audit_events \(organization_id, created_at DESC\)/);
  assert.match(migration.sql, /Cannot add tenant scope to a populated pre-production schema/);
  assert.doesNotMatch(migration.sql, /INSERT INTO organizations/i);
});

test("migration runner records applied checksums and skips tracked migrations", async () => {
  const migrations = [
    { version: "010_second", sql: "CREATE TABLE second_table ();" },
    { version: "002_first", sql: "CREATE TABLE first_table ();" }
  ];
  const client = new FakePostgresClient();
  const first = await runMigrations(client, { migrations });
  assert.deepEqual(first.applied, ["002_first", "010_second"]);
  assert.equal(client.calls.filter(call => call.sql === "BEGIN").length, 2);
  assert.equal(client.calls.some(call => call.sql.startsWith("SELECT pg_advisory_lock")), true);

  const second = await runMigrations(client, { migrations });
  assert.deepEqual(second.applied, []);
  assert.equal(client.calls.filter(call => call.sql === "BEGIN").length, 2);
});

test("migration runner fails closed on edited history and rolls back failed migration work", async () => {
  const migration = { version: "001_first", sql: "CREATE TABLE first_table ();" };
  const client = new FakePostgresClient({ applied: [{ version: migration.version, checksum: "0".repeat(64) }] });
  await assert.rejects(() => runMigrations(client, { migrations: [migration] }), /checksum mismatch/);

  const failing = new FakePostgresClient({ failSql: "CREATE TABLE broken_table ();" });
  await assert.rejects(
    () => runMigrations(failing, { migrations: [{ version: "001_broken", sql: "CREATE TABLE broken_table ();" }] }),
    /migration execution failed/
  );
  assert.equal(failing.calls.some(call => call.sql === "ROLLBACK"), true);
});

test("migration runner rejects ambiguous migration sequence numbers", async () => {
  const client = new FakePostgresClient();
  await assert.rejects(
    () => runMigrations(client, { migrations: [{ version: "001_first", sql: "SELECT 1;" }, { version: "1_duplicate", sql: "SELECT 2;" }] }),
    /Duplicate migration version/
  );
});
