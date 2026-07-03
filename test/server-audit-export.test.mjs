import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function request(method, url, { actor = "admin" } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", "x-labs-actor": actor };
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

test("server audit export route requires admin and returns bounded CSV metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-audit-export-server-"));
  process.env.VERCEL = "1";
  process.env.LABS_DEMO_MODE = "true";
  process.env.LABS_DB_PATH = join(directory, "labs.sqlite");
  process.env.LABS_WRITE_RATE_LIMIT_MAX = "100";
  process.env.LABS_WRITE_RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.LABS_OBSERVABILITY_EXPORTER = "otlp";
  const { handler } = await import(`../server.mjs?audit-export-test=${Date.now()}`);

  const forbidden = response();
  await handler(request("GET", "/api/v1/audit-events/export?from=2020-01-01&to=2099-12-31", { actor: "lab-lead" }), forbidden);
  const denied = await forbidden.done;
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN");
  assert.equal(JSON.stringify(denied.body).includes("audit_events"), false);

  const allowed = response();
  await handler(request("GET", "/api/v1/audit-events/export?from=2020-01-01&to=2099-12-31&limit=5"), allowed);
  const exported = await allowed.done;
  assert.equal(exported.status, 200);
  assert.equal(exported.body.export.metadata.format, "csv");
  assert.ok(exported.body.export.metadata.count <= 5);
  assert.match(exported.body.export.csv, /^export_id,generated_at,from,to,event_id,event_created_at,actor_id,action,entity_type,entity_id,before_present,after_present/);
  rmSync(directory, { recursive: true, force: true });
});
