import test from "node:test";
import assert from "node:assert/strict";
import { runtimeReadiness, validateRuntimeConfiguration } from "../src/runtime-config.mjs";

const productionEnvironment = {
  LABS_OIDC_ISSUER: "https://identity.example",
  LABS_OIDC_AUDIENCE: "dna-ai-labs",
  LABS_OIDC_CLIENT_ID: "dna-ai-labs-web",
  LABS_DATABASE_URL: "postgresql://configured-by-platform/dna_ai_labs",
  LABS_TENANT_ID: "company-internal",
  LABS_TENANT_CLAIM: "organization_id",
  LABS_ALLOWED_ARTIFACT_ORIGINS: "https://docs.example, https://source.example",
  LABS_NOTIFICATION_PROVIDER: "approved-provider",
  LABS_DIRECTORY_PROVIDER: "approved-provider",
  LABS_WORK_TRACKING_PROVIDER: "approved-provider",
  LABS_CALENDAR_PROVIDER: "approved-provider",
  LABS_ANALYTICS_PROVIDER: "approved-provider"
};

test("production configuration reports missing contracts without exposing values", () => {
  const result = validateRuntimeConfiguration({
    LABS_OIDC_ISSUER: "https://identity.example/private",
    LABS_DATABASE_URL: "postgresql://user:secret@db.example/internal"
  });

  assert.equal(result.mode, "production");
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("missing_oidc_audience"));
  assert.ok(result.issues.includes("missing_tenant_id"));
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("identity.example"), false);
});

test("production configuration accepts a complete non-secret contract and normalizes origins", () => {
  const result = validateRuntimeConfiguration(productionEnvironment);
  assert.equal(result.valid, true);
  assert.deepEqual(result.approvedArtifactOrigins, ["https://docs.example", "https://source.example"]);
  assert.deepEqual(result.issues, []);
});

test("artifact configuration requires HTTPS origins", () => {
  const result = validateRuntimeConfiguration({ ...productionEnvironment, LABS_ALLOWED_ARTIFACT_ORIGINS: "http://docs.example/path" });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("invalid_approved_artifact_origins"));
  assert.deepEqual(result.approvedArtifactOrigins, []);
});

test("demo mode is explicit and remains non-ready", () => {
  const configuration = validateRuntimeConfiguration({ LABS_DEMO_MODE: "true" });
  const readiness = runtimeReadiness({ LABS_DEMO_MODE: "true" });
  assert.equal(configuration.demoMode, true);
  assert.equal(configuration.valid, true);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("demo_mode_enabled"));
});

test("a complete production contract remains fail-closed until production adapters exist", () => {
  const readiness = runtimeReadiness(productionEnvironment);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, ["production_adapters_unavailable"]);
});
