import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { LabsStore } from "./src/labs-store.mjs";
import { WorkflowError } from "./src/workflow-policy.mjs";
import { runtimeReadiness, validateRuntimeConfiguration } from "./src/runtime-config.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const isVercel = Boolean(process.env.VERCEL);
const runtimeConfiguration = validateRuntimeConfiguration(process.env);
const demoMode = runtimeConfiguration.demoMode;
const approvedArtifactOrigins = runtimeConfiguration.approvedArtifactOrigins.length ? runtimeConfiguration.approvedArtifactOrigins : ["https://intranet.example"];
const store = demoMode ? new LabsStore(process.env.LABS_DB_PATH || (isVercel ? "/tmp/dna-ai-labs.sqlite" : join(root, "data", "labs.sqlite")), { approvedArtifactOrigins }) : null;

const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const responseSecurityHeaders = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "permissions-policy": "camera=(), microphone=(), geolocation=()" };

function respond(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...responseSecurityHeaders, ...headers });
  res.end(JSON.stringify(body));
}

function readiness() {
  const status = runtimeReadiness(process.env);
  const issues = [...status.issues];
  if (store && !store.health()) issues.push("database_unavailable");
  return { ready: false, mode: status.mode, issues };
}

function requireOperationalRuntime() {
  if (!store) {
    throw new WorkflowError("RUNTIME_NOT_CONFIGURED", "The production runtime is not yet configured for operation.", 503);
  }
}

async function body(req) {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw new WorkflowError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413); }
  try { return data ? JSON.parse(data) : {}; } catch { throw new WorkflowError("INVALID_JSON", "Request body must be valid JSON.", 400); }
}

function actor(req) {
  requireOperationalRuntime();
  const actorId = demoMode ? (req.headers["x-labs-actor"] || "lab-lead") : req.headers[process.env.LABS_IDENTITY_HEADER || "x-authenticated-user"];
  if (!actorId) throw new WorkflowError("UNAUTHENTICATED", "Sign-in is required. Configure the approved identity proxy before production use.", 401);
  return store.actor(actorId);
}

async function api(req, res, url) {
  requireOperationalRuntime();
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/v1/session") return respond(res, 200, { user: actor(req), demoMode });
  if (req.method === "GET" && path === "/api/v1/projects") return respond(res, 200, { projects: store.listProjects() });
  if (req.method === "GET" && path === "/api/v1/audit-events") return respond(res, 200, { events: store.auditEvents(actor(req), Number(url.searchParams.get("limit")) || 100) });
  if (req.method === "POST" && path === "/api/v1/intakes") return respond(res, 201, { project: store.createIntake(actor(req), await body(req)) });

  let match = path.match(/^\/api\/v1\/projects\/([^/]+)\/select$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: store.selectProject(actor(req), match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/start-incubation$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: store.startIncubation(actor(req), match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/adoption\/acknowledge$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: store.acknowledgeAdoption(actor(req), match[1]) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/evidence$/);
  if (req.method === "POST" && match) return respond(res, 201, { project: store.addEvidence(actor(req), match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/reviews\/([a-z_]+)$/);
  if (req.method === "PUT" && match) return respond(res, 200, { project: store.setReview(actor(req), match[1], match[2], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/gates\/([a-z_]+)$/);
  if (req.method === "PUT" && match) return respond(res, 200, { project: store.setGate(actor(req), match[1], match[2], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/handoff\/accept$/);
  if (req.method === "POST" && match) return respond(res, 200, { project: store.acceptHandoff(actor(req), match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/projects\/([^/]+)\/decision-requests$/);
  if (req.method === "POST" && match) return respond(res, 201, { decision: store.requestDecision(actor(req), match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/decisions\/([^/]+)\/approvals$/);
  if (req.method === "POST" && match) return respond(res, 200, { decision: store.approveDecision(actor(req), match[1], await body(req)) });
  match = path.match(/^\/api\/v1\/decisions\/([^/]+)\/finalize$/);
  if (req.method === "POST" && match) return respond(res, 200, store.finalizeDecision(actor(req), match[1]));
  return respond(res, 404, { error: { code: "NOT_FOUND", message: "API route not found." } });
}

async function staticFile(req, res, url) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = normalize(join(root, requestPath));
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath === "data" || relativePath.startsWith(`data${sep}`)) return respond(res, 403, { error: { code: "FORBIDDEN", message: "Not available." } });
  try {
    const file = await readFile(resolved);
    res.writeHead(200, { "content-type": contentTypes[extname(resolved)] || "application/octet-stream", ...responseSecurityHeaders, "content-security-policy": "default-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
    res.end(file);
  } catch { respond(res, 404, { error: { code: "NOT_FOUND", message: "Page not found." } }); }
}

export async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") return respond(res, store?.health() ? 200 : 503, { status: store?.health() ? "ok" : "error" });
    if (req.method === "GET" && url.pathname === "/readyz") {
      const status = readiness();
      return respond(res, status.ready ? 200 : 503, status);
    }
    if (url.pathname.startsWith("/api/")) await api(req, res, url); else await staticFile(req, res, url);
  } catch (error) {
    if (error instanceof WorkflowError) return respond(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    console.error(error);
    respond(res, 500, { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
  }
}

export default handler;

let server;
if (!isVercel) {
  const port = Number(process.env.PORT || 4173);
  server = http.createServer(handler);
  server.listen(port, () => console.log(`DNA AI Labs command center listening on http://localhost:${port} (${demoMode ? "explicit demo mode" : "production runtime fail-closed"})`));
}

function shutdown() { server?.close(() => { store.close(); process.exit(0); }); }
if (!isVercel) { process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown); }
