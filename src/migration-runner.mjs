import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDirectory = join(moduleDirectory, "..", "migrations");
const migrationFilePattern = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/;
const migrationVersionPattern = /^(\d+)_([a-z0-9][a-z0-9_-]*)$/;
const migrationLockKey = 912860301;

const schemaMigrationsSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (version ~ '^[0-9]+_[a-z0-9][a-z0-9_-]*$'),
    CHECK (checksum ~ '^[a-f0-9]{64}$')
  );
`;

function checksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

function normalizeMigration(migration) {
  if (!migration || typeof migration.version !== "string" || !migrationVersionPattern.test(migration.version) || typeof migration.sql !== "string" || !migration.sql.trim()) {
    throw new TypeError("Each migration needs a non-empty version and SQL body.");
  }
  return Object.freeze({ version: migration.version, sql: migration.sql, checksum: migration.checksum || checksum(migration.sql) });
}

function compareMigrations(left, right) {
  const leftNumber = BigInt(left.version.split("_", 1)[0]);
  const rightNumber = BigInt(right.version.split("_", 1)[0]);
  if (leftNumber < rightNumber) return -1;
  if (leftNumber > rightNumber) return 1;
  return left.version.localeCompare(right.version);
}

function assertUniqueVersions(migrations) {
  const versions = new Set();
  const sequenceNumbers = new Set();
  for (const migration of migrations) {
    const sequence = migration.version.split("_", 1)[0].replace(/^0+/, "") || "0";
    if (versions.has(migration.version) || sequenceNumbers.has(sequence)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);
    sequenceNumbers.add(sequence);
  }
}

/** Loads ordered, immutable SQL migrations from the repository. */
export function loadSqlMigrations(directory = defaultMigrationsDirectory) {
  const names = readdirSync(directory).filter(name => migrationFilePattern.test(name)).sort();
  const migrations = names.map(name => {
    const match = name.match(migrationFilePattern);
    return normalizeMigration({
      version: `${match[1]}_${match[2]}`,
      sql: readFileSync(join(directory, name), "utf8")
    });
  });
  const orderedMigrations = migrations.sort(compareMigrations);
  assertUniqueVersions(orderedMigrations);
  return Object.freeze(orderedMigrations);
}

async function rollback(client) {
  try { await client.query("ROLLBACK"); } catch { /* Keep the original migration error. */ }
}

/**
 * Applies repository SQL migrations through a minimal PostgreSQL-client interface.
 * The caller owns connecting and closing the client; this keeps the runner testable
 * and prevents the application server from opening a production connection implicitly.
 */
export async function runMigrations(client, { migrations = loadSqlMigrations(), useAdvisoryLock = true } = {}) {
  if (!client || typeof client.query !== "function") throw new TypeError("A PostgreSQL client with query(sql, params) is required.");
  const orderedMigrations = migrations.map(normalizeMigration).sort(compareMigrations);
  assertUniqueVersions(orderedMigrations);

  await client.query(schemaMigrationsSql);
  if (useAdvisoryLock) await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
  try {
    const result = await client.query("SELECT version, checksum FROM schema_migrations ORDER BY version");
    const applied = new Map((result.rows || []).map(row => [row.version, row.checksum]));
    for (const migration of orderedMigrations) {
      const storedChecksum = applied.get(migration.version);
      if (storedChecksum && storedChecksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch for ${migration.version}; applied migrations must not be edited.`);
      }
    }

    const appliedVersions = [];
    for (const migration of orderedMigrations) {
      if (applied.has(migration.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum]
        );
        await client.query("COMMIT");
        appliedVersions.push(migration.version);
      } catch (error) {
        await rollback(client);
        throw error;
      }
    }
    return Object.freeze({ applied: Object.freeze(appliedVersions), current: Object.freeze(orderedMigrations.map(migration => migration.version)) });
  } finally {
    if (useAdvisoryLock) await client.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
  }
}
