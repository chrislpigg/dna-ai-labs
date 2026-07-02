#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LabsStore } from "../src/labs-store.mjs";
import { createPostgresWorkflowAdapter } from "../src/postgres-workflow-adapter.mjs";
import { MetadataOnlyNotificationSender, NotificationWorker } from "../src/notification-worker.mjs";
import { validateRuntimeConfiguration } from "../src/runtime-config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);

function numberArg(name, fallback) {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = arg ? Number(arg.split("=").slice(1).join("=")) : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
  const runtime = validateRuntimeConfiguration(process.env);
  const limit = numberArg("limit", 25);
  const maxAttempts = numberArg("max-attempts", Number(process.env.LABS_NOTIFICATION_MAX_ATTEMPTS || 3));
  const retryDelayMs = numberArg("retry-delay-ms", Number(process.env.LABS_NOTIFICATION_RETRY_DELAY_MS || 60_000));
  if (!runtime.demoMode && process.env.LABS_NOTIFICATION_PROVIDER !== "metadata-log") {
    const error = new Error("Notification sender is not configured.");
    error.code = "NOTIFICATION_SENDER_UNCONFIGURED";
    throw error;
  }
  const sender = new MetadataOnlyNotificationSender();
  const workflow = runtime.demoMode
    ? new LabsStore(process.env.LABS_DB_PATH || join(projectRoot, "data", "labs.sqlite"))
    : createPostgresWorkflowAdapter({
      databaseUrl: process.env.LABS_DATABASE_URL,
      organizationId: process.env.LABS_TENANT_ID,
      approvedArtifactOrigins: runtime.approvedArtifactOrigins
    });

  try {
    const storage = runtime.demoMode ? workflow.storage : workflow;
    const worker = new NotificationWorker({
      storage,
      sender,
      workerId: process.env.LABS_NOTIFICATION_WORKER_ID || "notification-worker",
      maxAttempts,
      retryDelayMs
    });
    const summary = await worker.runOnce({ limit });
    process.stdout.write(`${JSON.stringify({ summary })}\n`);
  } finally {
    await workflow.close?.();
  }
}

main().catch(error => {
  const code = error?.code || error?.name || "NOTIFICATION_WORKER_FAILED";
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = 1;
});
