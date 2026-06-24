import { Client } from "pg";
import { loadSqlMigrations } from "./migration-runner.mjs";

function status({ connectivity, migrationState, pendingMigrations = [], issues = [] }) {
  return Object.freeze({
    ready: issues.length === 0,
    connectivity,
    migrationState,
    pendingMigrations: Object.freeze([...pendingMigrations]),
    issues: Object.freeze([...issues])
  });
}

function missingMigrationTable(error) {
  return error?.code === "42P01";
}

/**
 * Checks only service-owned schema metadata. It deliberately returns stable state
 * codes instead of database errors, connection details, or schema contents.
 */
export async function inspectDatabaseReadiness(client, { migrations = loadSqlMigrations() } = {}) {
  try {
    await client.query("SELECT 1");
  } catch {
    return status({ connectivity: "unavailable", migrationState: "unknown", issues: ["database_unavailable"] });
  }

  let applied;
  try {
    const result = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
    applied = new Map((result.rows || []).map(row => [row.version, row.checksum]));
  } catch (error) {
    if (missingMigrationTable(error)) {
      return status({ connectivity: "available", migrationState: "unavailable", issues: ["migrations_unavailable"] });
    }
    return status({ connectivity: "available", migrationState: "unavailable", issues: ["migration_state_unavailable"] });
  }

  const altered = migrations.some(migration => applied.has(migration.version) && applied.get(migration.version) !== migration.checksum);
  if (altered) {
    return status({ connectivity: "available", migrationState: "invalid", issues: ["migration_checksum_mismatch"] });
  }

  const pendingMigrations = migrations.filter(migration => !applied.has(migration.version)).map(migration => migration.version);
  if (pendingMigrations.length) {
    return status({ connectivity: "available", migrationState: "pending", pendingMigrations, issues: ["pending_migrations"] });
  }
  return status({ connectivity: "available", migrationState: "current" });
}

/** Production-only readiness probe. It owns short-lived clients so a failed probe cannot leak a checked-out workflow connection. */
export function createDatabaseReadinessProbe({ databaseUrl, ClientConstructor = Client, migrations = loadSqlMigrations() } = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl.trim()) throw new TypeError("A PostgreSQL database URL is required for database readiness.");
  return Object.freeze({
    async check() {
      const client = new ClientConstructor({ connectionString: databaseUrl });
      try {
        await client.connect();
        return await inspectDatabaseReadiness(client, { migrations });
      } catch {
        return status({ connectivity: "unavailable", migrationState: "unknown", issues: ["database_unavailable"] });
      } finally {
        try { await client.end(); } catch { /* A failed readiness probe remains non-sensitive. */ }
      }
    }
  });
}
