import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LabsStore } from "./src/labs-store.mjs";
import { LabsCatalog } from "./src/labs-catalog.mjs";
import { createIdentityProvider } from "./src/identity-provider.mjs";
import { createPostgresWorkflowAdapter } from "./src/postgres-workflow-adapter.mjs";
import { createDatabaseReadinessProbe } from "./src/database-readiness.mjs";
import { demoGroupRoleMapping, parseGroupRoleMapping, resolveApplicationRole } from "./src/role-mapping.mjs";
import { requireRole, roles, WorkflowError } from "./src/workflow-policy.mjs";
import { runtimeReadiness, validateRuntimeConfiguration } from "./src/runtime-config.mjs";
import { requireCsrfProtection, responseSecurityHeaders } from "./src/request-security.mjs";
import { createWriteRateLimiter } from "./src/rate-limiter.mjs";
import { correlationIdFromHeaders, createObservability } from "./src/observability.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const isVercel = Boolean(process.env.VERCEL);
const runtimeConfiguration = validateRuntimeConfiguration(process.env);
const demoMode = runtimeConfiguration.demoMode;
const groupRoleMapping = demoMode ? demoGroupRoleMapping() : parseGroupRoleMapping(process.env.LABS_GROUP_ROLE_MAPPING);
const approvedArtifactOrigins = runtimeConfiguration.approvedArtifactOrigins.length ? runtimeConfiguration.approvedArtifactOrigins : ["https://intranet.example"];
const observability = createObservability({ env: process.env, demoMode });
const store = demoMode ? new LabsStore(process.env.LABS_DB_PATH || (isVercel ? "/tmp/dna-ai-labs.sqlite" : join(root, "data", "labs.sqlite")), { approvedArtifactOrigins, observability }) : null;
const catalog = demoMode ? new LabsCatalog(process.env.LABS_CATALOG_DB_PATH || (isVercel ? "/tmp/dna-ai-labs-catalog.sqlite" : join(root, "data", "labs-catalog.sqlite"))) : null;
const postgresWorkflow = !demoMode && runtimeConfiguration.valid
  ? createPostgresWorkflowAdapter({ databaseUrl: process.env.LABS_DATABASE_URL, organizationId: process.env.LABS_TENANT_ID, approvedArtifactOrigins, observability })
  : null;
const workflow = store || postgresWorkflow;
const writeRateLimiter = createWriteRateLimiter({ env: process.env, demoMode, databaseUrl: process.env.LABS_DATABASE_URL });
const databaseReadiness = !demoMode && runtimeConfiguration.valid
  ? createDatabaseReadinessProbe({ databaseUrl: process.env.LABS_DATABASE_URL })
  : null;
const demoIdentities = demoMode ? Object.fromEntries(store.users().map(user => [user.id, {
  groups: [user.role], organization: "demo-tenant", sessionExpiresAt: "2099-01-01T00:00:00.000Z"
}])) : undefined;
const identityProvider = createIdentityProvider({
  demoMode,
  demoIdentities,
  demoDefaultSubject: "lab-lead",
  issuer: process.env.LABS_OIDC_ISSUER,
  audience: process.env.LABS_OIDC_AUDIENCE,
  jwksUri: process.env.LABS_OIDC_JWKS_URL,
  tenantClaim: process.env.LABS_TENANT_CLAIM
});

const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
function respond(res, status, body, headers = {}) {
  res._labsStatusCode = status;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-correlation-id": res._labsCorrelationId || randomUUID(), ...responseSecurityHeaders, ...headers });
  res.end(JSON.stringify(body));
}

async function readiness() {
  const status = runtimeReadiness(process.env);
  const issues = [...status.issues];
  if (store && !store.health()) issues.push("database_unavailable");
  const database = databaseReadiness
    ? await databaseReadiness.check()
    : { connectivity: demoMode ? "demo" : "unconfigured", migrationState: demoMode ? "not_applicable" : "unknown", pendingMigrations: [], issues: [] };
  issues.push(...database.issues);
  return { ready: issues.length === 0, mode: status.mode, issues: [...new Set(issues)], database };
}

async function requireOperationalRuntime() {
  if (!workflow) {
    throw new WorkflowError("RUNTIME_NOT_CONFIGURED", "The production runtime is not yet configured for operation.", 503);
  }
  if (databaseReadiness) {
    const database = await databaseReadiness.check();
    if (!database.ready) throw new WorkflowError("DATABASE_NOT_READY", "The authoritative database is not ready for operation.", 503, { issues: database.issues });
  }
}

function requireProductionTenant(identity) {
  if (!demoMode && identity.organization !== process.env.LABS_TENANT_ID) {
    throw new WorkflowError("TENANT_SCOPE_MISMATCH", "The verified identity is not authorized for this tenant.", 403);
  }
}

async function body(req) {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw new WorkflowError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413); }
  try { return data ? JSON.parse(data) : {}; } catch { throw new WorkflowError("INVALID_JSON", "Request body must be valid JSON.", 400); }
}

async function actor(req) {
  const identity = await identityProvider.authenticate(req);
  await requireOperationalRuntime();
  requireProductionTenant(identity);
  const role = resolveApplicationRole(identity.groups, groupRoleMapping);
  const user = store ? store.actor(identity.subject) : await postgresWorkflow.getActorBySubject(identity.subject, role);
  return { ...user, role, identity };
}

async function api(req, res, url) {
  const requestActor = await actor(req);
  req._labsActor = requestActor;
  requireCsrfProtection(req, {
    authenticationMode: identityProvider.authenticationMode,
    applicationOrigin: process.env.LABS_APPLICATION_ORIGIN
  });
  const path = url.pathname;
  await writeRateLimiter.check({ method: req.method, path, actorId: requestActor.id, organizationId: requestActor.identity?.organization || process.env.LABS_TENANT_ID || "demo-tenant" });
  if (req.method === "GET" && path === "/api/v1/session") return respond(res, 200, { user: requestActor, demoMode });
  if (path === "/api/v1/tools" || path.startsWith("/api/v1/tools/")) {
    if (!catalog) throw new WorkflowError("CATALOG_UNAVAILABLE", "The Labs hub is available only in demo mode.", 503);
    if (req.method === "GET" && path === "/api/v1/tools") return respond(res, 200, { tools: catalog.listTools(requestActor.id, url.searchParams.get("sort")) });
    if (req.method === "POST" && path === "/api/v1/tools") return respond(res, 201, { tool: catalog.addTool(requestActor, await body(req)) });
    let toolMatch = path.match(/^\/api\/v1\/tools\/([^/]+)\/vote$/);
    if (req.method === "POST" && toolMatch) return respond(res, 200, { tool: catalog.toggleVote(requestActor, toolMatch[1]) });
    toolMatch = path.match(/^\/api\/v1\/tools\/([^/]+)\/comments$/);
    if (req.method === "GET" && toolMatch) return respond(res, 200, { comments: catalog.listComments(toolMatch[1]) });
    if (req.method === "POST" && toolMatch) return respond(res, 201, catalog.addComment(requestActor, toolMatch[1], await body(req)));
  }
  if (req.method === "GET" && path === "/api/v1/directory/people") return respond(res, 200, { people: await workflow.searchDirectoryPeople(requestActor, url.searchParams.get("q")) });
  if (req.method === "GET" && path === "/api/v1/cycles") return respond(res, 200, { cycles: await workflow.listCycles(requestActor) });
  if (req.method === "POST" && path === "/api/v1/cycles") return respond(res, 201, { cycle: await workflow.createCycle(requestActor, await body(req)) });
  if (req.method === "GET" && path === "/api/v1/feature-flags") return respond(res, 200, { flags: await workflow.listFeatureFlags(requestActor) });
  if (req.method === "GET" && path === "/api/v1/role-assignments") return respond(res, 200, { assignments: await workflow.listRoleAssignments(requestActor) });
  if (req.method === "GET" && path === "/api/v1/integrations/health") return respond(res, 200, await workflow.integrationHealth(requestActor));
  if (req.method === "GET" && path === "/api/v1/observability/metrics") {
    requireRole(requestActor, [roles.ADMIN]);
    return respond(res, 200, { metrics: observability.snapshot() });
  }
  if (req.method === "GET" && path === "/api/v1/notifications/outbox") return respond(res, 200, { notifications: await workflow.notificationOutbox(requestActor, Number(url.searchParams.get("limit")) || 100) });
  if (req.method === "GET" && path === "/api/v1/fellow-assignments") return respond(res, 200, { assignments: await workflow.listFellowAssignments(requestActor, { cycleId: url.searchParams.get("cycleId"), projectId: url.searchParams.get("projectId") }) });
  if (req.method === "POST" && path === "/api/v1/fellow-assignments") return respond(res, 201, { assignment: await workflow.createFellowAssignment(requestActor, await body(req)) });
  if (req.method === "GET" && path === "/api/v1/portfolio-metrics") return respond(res, 200, { metrics: await workflow.portfolioMetrics(requestActor, Object.fromEntries(url.searchParams)) });
  if (req.method === "GET" && path === "/api/v1/projects") return respond(res, 200, { projects: await workflow.listProjects() });
  if (req.method === "GET" && path === "/api/v1/audit-events") {
    requireRole(requestActor, [roles.LAB_LEAD, roles.EXECUTIVE_SPONSOR, roles.ADMIN]);
    const limit = Number(url.searchParams.get("limit")) || 100;
    return respond(res, 200, { events: store ? store.auditEvents(requestActor, limit) : await workflow.listAuditEvents(limit) });
  }
  if (req.method === "GET" && path === "/api/v1/audit-events/export") {
    return respond(res, 200, { export: await workflow.exportAuditEvents(requestActor, Object.fromEntries(url.searchParams)) });
  }
  if (req.method === "GET" && path === "/api/v1/audit-events/verify") {
    requireRole(requestActor, [roles.ADMIN]);
    return respond(res, 200, { integrity: await workflow.verifyAuditIntegrity() });
  }
  if (req.method === "GET" && path === "/api/v1/intake-drafts") return respond(res, 200, { drafts: await workflow.listIntakeDrafts(requestActor) });
  if (req.method === "POST" && path === "/api/v1/intake-drafts") return respond(res, 201, { draft: await workflow.createIntakeDraft(requestActor, await body(req)) });
  if (req.method === "POST" && path === "/api/v1/intakes") return respond(res, 201, { project: await workflow.createIntake(requestActor, await body(req)) });

  let match = path.match(/^\/api\/v1\/intake-drafts\/([^/]+)\/submit$/);
  if (req.method === "POST" && match) return respond(res, 201, { project: await workflow.submitIntakeDraft(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/cycles\/([^/]+)$/);
  if (req.method === "PATCH" && match) return respond(res, 200, { cycle: await workflow.updateCycle(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/feature-flags\/([a-z_]+)$/);
  if (req.method === "PATCH" && match) return respond(res, 200, { flag: await workflow.setFeatureFlag(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/role-assignments\/([^/]+)$/);
  if (req.method === "PATCH" && match) return respond(res, 200, { assignment: await workflow.setRoleAssignment(requestActor, decodeURIComponent(match[1]), await body(req)) });
  match = path.match(/^\/api\/v1\/fellow-assignments\/([^/]+)$/);
  if (req.method === "PATCH" && match) return respond(res, 200, { assignment: await workflow.updateFellowAssignment(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/fellow-assignments\/([^/]+)\/manager-acknowledgement$/);
  if (req.method === "POST" && match) return respond(res, 200, { assignment: await workflow.acknowledgeFellowAssignment(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/intakes\/([^/]+)\/triage-comments$/);
  if (req.method === "GET" && match) return respond(res, 200, { comments: await workflow.listTriageComments(requestActor, match[1]) });
  if (req.method === "POST" && match) return respond(res, 201, { comments: await workflow.addTriageComment(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/intakes\/([^/]+)\/request-information$/);
  if (req.method === "POST" && match) return respond(res, 200, await workflow.requestTriageInformation(requestActor, match[1], await body(req)));
  match = path.match(/^\/api\/v1\/intakes\/([^/]+)\/resubmit$/);
  if (req.method === "POST" && match) return respond(res, 200, await workflow.resubmitIntake(requestActor, match[1], await body(req)));
  match = path.match(/^\/api\/v1\/intakes\/([^/]+)\/revisions\/compare$/);
  if (req.method === "GET" && match) return respond(res, 200, await workflow.compareIntakeRevisions(requestActor, match[1], url.searchParams.get("from"), url.searchParams.get("to")));
  match = path.match(/^\/api\/v1\/intakes\/([^/]+)\/withdraw$/);
  if (req.method === "POST" && match) return respond(res, 200, { intake: await workflow.withdrawIntake(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/intake-drafts\/([^/]+)\/collaborators$/);
  if (req.method === "POST" && match) return respond(res, 200, { draft: await workflow.addIntakeDraftCollaborator(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/intake-drafts\/([^/]+)\/collaborators\/([^/]+)$/);
  if (req.method === "DELETE" && match) return respond(res, 200, { draft: await workflow.removeIntakeDraftCollaborator(requestActor, match[1], decodeURIComponent(match[2])) });
  match = path.match(/^\/api\/v1\/intake-drafts\/([^/]+)$/);
  if (req.method === "GET" && match) return respond(res, 200, { draft: await workflow.intakeDraft(requestActor, match[1]) });
  if (req.method === "PATCH" && match) return respond(res, 200, { draft: await workflow.updateIntakeDraft(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (req.method === "DELETE" && match) return respond(res, 204, await workflow.deleteProject(requestActor, match[1], (await body(req)).deletionReason));
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/restore$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: await workflow.restoreProject(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/select$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: await workflow.selectProject(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/start-incubation$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: await workflow.startIncubation(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/adoption\/acknowledge$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: await workflow.acknowledgeAdoption(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/evidence$/);
  if (req.method === "POST" && match) return respond(res, 201, { project: await workflow.addEvidence(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/delivery-kit$/);
  if (req.method === "GET" && match) return respond(res, 200, { deliveryKit: await workflow.listDeliveryKit(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/delivery-kit\/([a-z_]+)$/);
  if (req.method === "PUT" && match) return respond(res, 200, { item: await workflow.upsertDeliveryKitItem(requestActor, match[1], match[2], await body(req)) });
  if (req.method === "DELETE" && match) return respond(res, 200, { item: await workflow.deleteDeliveryKitItem(requestActor, match[1], match[2]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/work-item$/);
  if (req.method === "POST" && match) return respond(res, 200, { workItem: await workflow.createOrLinkWorkItem(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/work-item\/refresh$/);
  if (req.method === "POST" && match) return respond(res, 200, { workItem: await workflow.refreshWorkItem(requestActor, match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/metric-plan$/);
  if (req.method === "PUT" && match) return respond(res, 200, { metricPlan: await workflow.upsertMetricPlan(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/metric-plan\/refresh$/);
  if (req.method === "POST" && match) return respond(res, 200, { metricPlan: await workflow.refreshMetricPlan(requestActor, match[1], (await body(req)).metricKey || "primary") });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/calendar-events$/);
  if (req.method === "GET" && match) return respond(res, 200, { events: await workflow.listCalendarEvents(requestActor, match[1]) });
  if (req.method === "POST" && match) return respond(res, 200, { event: await workflow.scheduleCalendarEvent(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/reviews\/([a-z_]+)$/);
  if (req.method === "PUT" && match) return respond(res, 200, { project: await workflow.setReview(requestActor, match[1], match[2], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/gates\/([a-z_]+)$/);
  if (req.method === "PUT" && match) return respond(res, 200, { project: await workflow.setGate(requestActor, match[1], match[2], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/handoff\/accept$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: await workflow.acceptHandoff(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/decision-requests$/);
  if (req.method === "POST" && match) return respond(res, 201, { decision: await workflow.requestDecision(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/decisions\/([^/]+)\/approvals$/);
  if (req.method === "POST" && match) return respond(res, 200, { decision: await workflow.approveDecision(requestActor, match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/decisions\/([^/]+)\/finalize$/);
  if (req.method === "POST" && match) return respond(res, 200, await workflow.finalizeDecision(requestActor, match[1]));
  return respond(res, 404, { error: { code: "NOT_FOUND", message: "API route not found." } });
}

async function staticFile(req, res, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = normalize(join(root, requestPath));
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath === "data" || relativePath.startsWith(`data${sep}`)) return respond(res, 403, { error: { code: "FORBIDDEN", message: "Not available." } });
  try {
    const file = await readFile(resolved);
    res._labsStatusCode = 200;
    res.writeHead(200, { "content-type": contentTypes[extname(resolved)] || "application/octet-stream", "x-correlation-id": res._labsCorrelationId || randomUUID(), ...responseSecurityHeaders });
    res.end(file);
  } catch { respond(res, 404, { error: { code: "NOT_FOUND", message: "Page not found." } }); }
}

export async function handler(req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const correlationId = correlationIdFromHeaders(req.headers);
  res._labsCorrelationId = correlationId;
  let errorCode = null;
  return observability.withContext({ correlationId }, async () => {
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        const database = databaseReadiness ? await databaseReadiness.check() : null;
        const healthy = workflow ? await workflow.health() && (!database || database.ready) : false;
        return respond(res, healthy ? 200 : 503, { status: healthy ? "ok" : "error" });
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        const status = await readiness();
        return respond(res, status.ready ? 200 : 503, status);
      }
      if (url.pathname.startsWith("/api/")) await api(req, res, url); else await staticFile(req, res, url);
    } catch (error) {
      if (error instanceof WorkflowError) {
        errorCode = error.code;
        const headers = error.code === "RATE_LIMITED" && error.details?.retryAfterSeconds ? { "retry-after": String(error.details.retryAfterSeconds) } : {};
        respond(res, error.status, { error: { code: error.code, message: error.message, details: error.details } }, headers);
      } else {
        errorCode = "INTERNAL_ERROR";
        observability.emit("error", { code: "INTERNAL_ERROR", message: "Unexpected request failure." });
        respond(res, 500, { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
      }
    } finally {
      const actorMeta = req._labsActor;
      const route = url.pathname;
      const statusCode = res._labsStatusCode || 500;
      const base = {
        correlationId,
        method: req.method,
        route,
        statusCode,
        durationMs: Date.now() - startedAt,
        actorId: actorMeta?.id || null,
        role: actorMeta?.role || null,
        organizationId: actorMeta?.identity?.organization || process.env.LABS_TENANT_ID || (demoMode ? "demo-tenant" : null),
        errorCode
      };
      observability.request(base);
      if (url.pathname.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && statusCode < 400) {
        observability.workflow({ ...base, result: "success" });
      }
      if ([401, 403, 429].includes(statusCode) || ["CSRF", "RATE_LIMIT", "TENANT", "UNAUTHENTICATED", "UNVERIFIED"].some(prefix => String(errorCode || "").startsWith(prefix))) {
        observability.security({ ...base, code: errorCode || `HTTP_${statusCode}` });
      }
    }
  });
}

export default handler;

let server;
if (!isVercel) {
  const port = Number(process.env.PORT || 4173);
  server = http.createServer(handler);
  server.listen(port, () => console.log(`DNA AI Labs command center listening on http://localhost:${port} (${demoMode ? "explicit demo mode" : "production runtime fail-closed"})`));
}

function shutdown() { server?.close(() => { catalog?.close(); Promise.resolve(workflow?.close()).finally(() => Promise.resolve(writeRateLimiter?.close?.()).finally(() => process.exit(0))); }); }
if (!isVercel) { process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown); }
