import test from "node:test";
import assert from "node:assert/strict";
import { createDatabaseReadinessProbe, inspectDatabaseReadiness } from "../src/database-readiness.mjs";

const migrations = [
  { version: "001_first", checksum: "a".repeat(64), sql: "SELECT 1;" },
  { version: "002_second", checksum: "b".repeat(64), sql: "SELECT 2;" }
];

class FakeClient {
  constructor({ rows = [], connectError, migrationError } = {}) {
    this.rows = rows;
    this.connectError = connectError;
    this.migrationError = migrationError;
    this.ended = false;
  }

  async query(sql) {
    if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }] };
    if (sql.startsWith("SELECT version, checksum")) {
      if (this.migrationError) throw this.migrationError;
      return { rows: this.rows };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  async connect() { if (this.connectError) throw this.connectError; }
  async end() { this.ended = true; }
}

test("database readiness reports current connectivity and migration state without connection details", async () => {
  const result = await inspectDatabaseReadiness(new FakeClient({ rows: migrations.map(({ version, checksum }) => ({ version, checksum })) }), { migrations });
  assert.deepEqual(result, {
    ready: true,
    connectivity: "available",
    migrationState: "current",
    pendingMigrations: [],
    issues: []
  });
});

test("database readiness fails closed for absent or altered migration history", async () => {
  const pending = await inspectDatabaseReadiness(new FakeClient({ rows: [{ version: "001_first", checksum: "a".repeat(64) }] }), { migrations });
  assert.equal(pending.ready, false);
  assert.equal(pending.migrationState, "pending");
  assert.deepEqual(pending.pendingMigrations, ["002_second"]);
  assert.deepEqual(pending.issues, ["pending_migrations"]);

  const missingTable = await inspectDatabaseReadiness(new FakeClient({ migrationError: { code: "42P01", message: "schema_migrations missing" } }), { migrations });
  assert.deepEqual(missingTable.issues, ["migrations_unavailable"]);

  const altered = await inspectDatabaseReadiness(new FakeClient({ rows: [{ version: "001_first", checksum: "wrong" }] }), { migrations });
  assert.deepEqual(altered.issues, ["migration_checksum_mismatch"]);
});

test("production readiness probe does not surface database errors and always closes its client", async () => {
  let client;
  class FailingClient extends FakeClient {
    constructor(options) { super(options); client = this; }
  }
  const probe = createDatabaseReadinessProbe({ databaseUrl: "postgresql://configured-by-platform/dna_ai_labs", ClientConstructor: FailingClient, migrations });
  const result = await probe.check();
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, ["pending_migrations"]);
  assert.equal(client.ended, true);

  const unavailable = await inspectDatabaseReadiness({ async query() { throw new Error("postgresql://secret@host failed"); } }, { migrations });
  assert.deepEqual(unavailable, {
    ready: false,
    connectivity: "unavailable",
    migrationState: "unknown",
    pendingMigrations: [],
    issues: ["database_unavailable"]
  });
});
