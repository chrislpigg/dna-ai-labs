import { Client } from "pg";
import { runMigrations } from "../src/migration-runner.mjs";

if (process.env.LABS_DEMO_MODE === "true") {
  throw new Error("Refusing to run PostgreSQL migrations while LABS_DEMO_MODE=true.");
}

const databaseUrl = typeof process.env.LABS_DATABASE_URL === "string" ? process.env.LABS_DATABASE_URL.trim() : "";
if (!databaseUrl) {
  throw new Error("LABS_DATABASE_URL is required to run production migrations.");
}
try {
  const url = new URL(databaseUrl);
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) throw new Error("Unsupported protocol");
} catch {
  throw new Error("LABS_DATABASE_URL must be a PostgreSQL connection URL.");
}

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const result = await runMigrations(client);
  console.log(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ") || "none"}`);
} finally {
  await client.end();
}
