import test from "node:test";
import assert from "node:assert/strict";
import { runtimeReadiness, validateRuntimeConfiguration } from "../src/runtime-config.mjs";

const productionEnvironment = {
  LABS_OIDC_ISSUER: "https://identity.example",
  LABS_OIDC_AUDIENCE: "dna-ai-labs",
  LABS_OIDC_JWKS_URL: "https://identity.example/keys",
  LABS_OIDC_CLIENT_ID: "dna-ai-labs-web",
  LABS_DATABASE_URL: "postgresql://configured-by-platform/dna_ai_labs",
  LABS_TENANT_ID: "company-internal",
  LABS_TENANT_CLAIM: "organization_id",
  LABS_GROUP_ROLE_MAPPING: JSON.stringify({
    employee: ["group-employee"],
    submitter: ["group-submitter"],
    "project-lead": ["group-project-lead"],
    fellow: ["group-fellow"],
    "receiving-owner": ["group-receiving-owner"],
    "steering-reviewer": ["group-steering-reviewer"],
    "lab-lead": ["group-lab-lead"],
    "executive-sponsor": ["group-executive-sponsor"],
    "platform-reviewer": ["group-platform-reviewer"],
    admin: ["group-admin"]
  }),
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
  assert.ok(result.issues.includes("missing_group_role_mapping"));
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

test("OIDC issuer and JWKS configuration require HTTPS URLs", () => {
  const result = validateRuntimeConfiguration({ ...productionEnvironment, LABS_OIDC_ISSUER: "http://identity.example", LABS_OIDC_JWKS_URL: "not-a-url" });
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("invalid_oidc_issuer"));
  assert.ok(result.issues.includes("invalid_oidc_jwks_url"));
  assert.equal(JSON.stringify(result).includes("identity.example"), false);
});

test("production configuration rejects incomplete or overlapping group role mappings", () => {
  const incomplete = validateRuntimeConfiguration({ ...productionEnvironment, LABS_GROUP_ROLE_MAPPING: JSON.stringify({ employee: ["employees"] }) });
  assert.equal(incomplete.valid, false);
  assert.ok(incomplete.issues.includes("invalid_group_role_mapping"));

  const overlapping = validateRuntimeConfiguration({ ...productionEnvironment, LABS_GROUP_ROLE_MAPPING: productionEnvironment.LABS_GROUP_ROLE_MAPPING.replace("group-submitter", "group-employee") });
  assert.equal(overlapping.valid, false);
  assert.ok(overlapping.issues.includes("invalid_group_role_mapping"));
});

test("demo mode is explicit and remains non-ready", () => {
  const configuration = validateRuntimeConfiguration({ LABS_DEMO_MODE: "true" });
  const readiness = runtimeReadiness({ LABS_DEMO_MODE: "true" });
  assert.equal(configuration.demoMode, true);
  assert.equal(configuration.valid, true);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("demo_mode_enabled"));
});

test("a complete production contract remains fail-closed until the mutation adapter exists", () => {
  const readiness = runtimeReadiness(productionEnvironment);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, ["production_mutation_adapter_unavailable"]);
});
