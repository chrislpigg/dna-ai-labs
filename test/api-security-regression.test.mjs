import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresReadAdapter } from "../src/postgres-read-adapter.mjs";
import { csrfCookieName, csrfHeaderName, requireCsrfProtection } from "../src/request-security.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

class QueryMock {
  constructor(responses = []) { this.responses = [...responses]; this.calls = []; }
  async query(sql, params = []) {
    this.calls.push({ sql, params });
    return this.responses.shift() || { rows: [] };
  }
}

function request(method, url, { actor = "submitter-1", body = undefined, headers = {} } = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", "x-labs-actor": actor, "content-type": "application/json", ...headers };
  return req;
}

function response() {
  let resolve;
  const done = new Promise(result => { resolve = result; });
  return {
    done,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(payload) {
      resolve({ status: this.status, headers: this.headers, body: payload ? JSON.parse(payload) : null });
    }
  };
}

async function testServer(label, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), `dna-ai-labs-security-${label}-`));
  process.env.VERCEL = "1";
  process.env.LABS_DEMO_MODE = "true";
  process.env.LABS_DB_PATH = join(directory, "labs.sqlite");
  process.env.LABS_WRITE_RATE_LIMIT_MAX = String(env.rateLimitMax ?? 100);
  process.env.LABS_WRITE_RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.LABS_OBSERVABILITY_EXPORTER = "otlp";
  const imported = await import(`../server.mjs?api-security-${label}-${Date.now()}`);
  return { handler: imported.handler, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

function assertSafeError(result, forbiddenText) {
  const serialized = JSON.stringify(result.body);
  assert.equal(Object.hasOwn(result.body, "error"), true);
  for (const text of forbiddenText) assert.equal(serialized.includes(text), false);
}

test("API rejects IDOR, role escalation, mass assignment, injection input, and unauthorized export without leaking sensitive content", async () => {
  const { handler, dispose } = await testServer("surface");
  try {
    const createDraft = response();
    await handler(request("POST", "/api/v1/intake-drafts", { body: { content: { title: "Private roadmap draft" } } }), createDraft);
    const draft = await createDraft.done;
    assert.equal(draft.status, 201);

    const idor = response();
    await handler(request("GET", `/api/v1/intake-drafts/${draft.body.draft.id}`, { actor: "employee-1" }), idor);
    const idorResult = await idor.done;
    assert.equal(idorResult.status, 403);
    assertSafeError(idorResult, ["Private roadmap draft", draft.body.draft.id]);

    const massAssignment = response();
    await handler(request("PATCH", `/api/v1/intake-drafts/${draft.body.draft.id}`, {
      body: { ownerId: "admin", status: "Submitted", content: { title: "Taken over" } }
    }), massAssignment);
    const massAssignmentResult = await massAssignment.done;
    assert.equal(massAssignmentResult.status, 403);
    assertSafeError(massAssignmentResult, ["Taken over"]);

    const roleEscalation = response();
    await handler(request("PATCH", "/api/v1/role-assignments/employee-1", {
      actor: "lab-lead",
      body: { role: "admin", active: true }
    }), roleEscalation);
    const roleEscalationResult = await roleEscalation.done;
    assert.equal(roleEscalationResult.status, 403);
    assertSafeError(roleEscalationResult, ["admin", "employee-1"]);

    const injection = response();
    const injectedQuery = "' OR '1'='1";
    await handler(request("GET", `/api/v1/directory/people?q=${encodeURIComponent(injectedQuery)}`), injection);
    const injectionResult = await injection.done;
    assert.equal(injectionResult.status, 200);
    assert.deepEqual(injectionResult.body.people, []);
    assert.equal(JSON.stringify(injectionResult.body).includes(injectedQuery), false);

    const exportAttempt = response();
    await handler(request("GET", "/api/v1/audit-events/export?from=2020-01-01&to=2099-12-31", { actor: "lab-lead" }), exportAttempt);
    const exportResult = await exportAttempt.done;
    assert.equal(exportResult.status, 403);
    assertSafeError(exportResult, ["audit_export_requested", "export_id", "csv"]);
  } finally { dispose(); }
});

test("cookie CSRF regression rejects cross-site and mismatched mutation tokens without echoing token values", () => {
  const applicationOrigin = "https://labs.example";
  const request = {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      cookie: `${csrfCookieName}=server-secret`,
      [csrfHeaderName]: "attacker-secret"
    }
  };
  assert.throws(
    () => requireCsrfProtection(request, { authenticationMode: "cookie", applicationOrigin }),
    error => error instanceof WorkflowError
      && error.code === "CSRF_ORIGIN_INVALID"
      && !JSON.stringify(error).includes("server-secret")
      && !JSON.stringify(error).includes("attacker-secret")
  );
});

test("API rate-limit regression returns bounded guidance without request payload content", async () => {
  const { handler, dispose } = await testServer("rate-limit", { rateLimitMax: 1 });
  try {
    const body = { content: { title: "Do not echo this limited payload" } };
    const first = response();
    await handler(request("POST", "/api/v1/intake-drafts", { body }), first);
    assert.equal((await first.done).status, 201);

    const second = response();
    await handler(request("POST", "/api/v1/intake-drafts", { body }), second);
    const limited = await second.done;
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    assert.equal(limited.body.error.details.limit, 1);
    assert.equal(limited.body.error.details.windowSeconds, 60);
    assert.equal(JSON.stringify(limited.body).includes("Do not echo this limited payload"), false);
  } finally { dispose(); }
});

test("tenant and injection regressions keep PostgreSQL security boundaries parameterized", async () => {
  const database = new QueryMock([
    { rows: [] },
    { rows: [] }
  ]);
  const adapter = new PostgresReadAdapter({ queryable: database, organizationId: "tenant-a" });

  await assert.rejects(
    () => adapter.getActorBySubject("subject' OR '1'='1", "admin"),
    error => error instanceof WorkflowError && error.code === "UNAUTHENTICATED"
  );
  await adapter.listAuditEventsForExport({ from: "2026-07-01T00:00:00.000Z", to: "2026-07-02T00:00:00.000Z", limit: 100 });

  assert.match(database.calls[0].sql, /organization_id = \$1 AND subject_ref = \$2/);
  assert.deepEqual(database.calls[0].params, ["tenant-a", "subject' OR '1'='1"]);
  assert.match(database.calls[1].sql, /organization_id = \$1 AND created_at >= \$2 AND created_at <= \$3/);
  assert.equal(database.calls[1].params[0], "tenant-a");
  assert.equal(database.calls.some(call => call.sql.includes("tenant-b") || call.sql.includes("OR '1'='1")), false);
});
