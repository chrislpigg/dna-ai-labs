import { parseGroupRoleMapping } from "./role-mapping.mjs";

const requiredProductionVariables = Object.freeze([
  ["LABS_OIDC_ISSUER", "missing_oidc_issuer"],
  ["LABS_OIDC_AUDIENCE", "missing_oidc_audience"],
  ["LABS_OIDC_JWKS_URL", "missing_oidc_jwks_url"],
  ["LABS_OIDC_CLIENT_ID", "missing_oidc_client_id"],
  ["LABS_DATABASE_URL", "missing_database_url"],
  ["LABS_TENANT_ID", "missing_tenant_id"],
  ["LABS_TENANT_CLAIM", "missing_tenant_claim"],
  ["LABS_GROUP_ROLE_MAPPING", "missing_group_role_mapping"],
  ["LABS_ALLOWED_ARTIFACT_ORIGINS", "missing_approved_artifact_origins"],
  ["LABS_NOTIFICATION_PROVIDER", "missing_notification_provider"],
  ["LABS_DIRECTORY_PROVIDER", "missing_directory_provider"],
  ["LABS_WORK_TRACKING_PROVIDER", "missing_work_tracking_provider"],
  ["LABS_CALENDAR_PROVIDER", "missing_calendar_provider"],
  ["LABS_ANALYTICS_PROVIDER", "missing_analytics_provider"]
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function httpsUrl(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function approvedArtifactOrigins(value) {
  const origins = text(value).split(",").map(origin => origin.trim()).filter(Boolean);
  if (!origins.length) return { origins: [], valid: false };
  try {
    const normalized = origins.map(origin => {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin) throw new Error("An approved artifact entry must be an HTTPS origin.");
      return url.origin;
    });
    return { origins: [...new Set(normalized)], valid: true };
  } catch {
    return { origins: [], valid: false };
  }
}

export function validateRuntimeConfiguration(env = process.env) {
  const demoMode = text(env.LABS_DEMO_MODE) === "true";
  const artifactOrigins = approvedArtifactOrigins(env.LABS_ALLOWED_ARTIFACT_ORIGINS);
  const groupRoleMapping = parseGroupRoleMapping(env.LABS_GROUP_ROLE_MAPPING);
  const issues = [];

  if (!demoMode) {
    for (const [name, code] of requiredProductionVariables) {
      if (!text(env[name])) issues.push(code);
    }
    if (text(env.LABS_OIDC_ISSUER) && !httpsUrl(env.LABS_OIDC_ISSUER)) issues.push("invalid_oidc_issuer");
    if (text(env.LABS_OIDC_JWKS_URL) && !httpsUrl(env.LABS_OIDC_JWKS_URL)) issues.push("invalid_oidc_jwks_url");
    if (text(env.LABS_ALLOWED_ARTIFACT_ORIGINS) && !artifactOrigins.valid) {
      issues.push("invalid_approved_artifact_origins");
    }
    if (text(env.LABS_GROUP_ROLE_MAPPING) && !groupRoleMapping) issues.push("invalid_group_role_mapping");
  }

  return Object.freeze({
    mode: demoMode ? "demo" : "production",
    demoMode,
    approvedArtifactOrigins: artifactOrigins.origins,
    valid: demoMode || issues.length === 0,
    issues: Object.freeze(issues)
  });
}

export function runtimeReadiness(env = process.env) {
  const configuration = validateRuntimeConfiguration(env);
  const issues = [...configuration.issues];
  if (configuration.demoMode) issues.push("demo_mode_enabled");
  else if (configuration.valid) {
    // Portfolio reads can use PostgreSQL, but the transaction-backed mutation
    // adapter is still required before a production deployment is ready.
    issues.push("production_mutation_adapter_unavailable");
  }
  return Object.freeze({ ready: false, mode: configuration.mode, issues: Object.freeze(issues), configuration });
}
