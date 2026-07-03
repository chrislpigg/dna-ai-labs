import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function request(method, url, { actor = "admin", correlationId = "corr-server-1234" } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", "x-labs-actor": actor, "x-correlation-id": correlationId };
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

test("server exposes sanitized application metrics and correlation ids", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-observability-server-"));
  process.env.VERCEL = "1";
  process.env.LABS_DEMO_MODE = "true";
  process.env.LABS_DB_PATH = join(directory, "labs.sqlite");
  process.env.LABS_WRITE_RATE_LIMIT_MAX = "100";
  process.env.LABS_WRITE_RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.LABS_OBSERVABILITY_EXPORTER = "otlp";
  const { handler } = await import(`../server.mjs?observability-test=${Date.now()}`);

  const session = response();
  await handler(request("GET", "/api/v1/session", { correlationId: "corr-session-1234" }), session);
  const sessionResult = await session.done;
  assert.equal(sessionResult.status, 200);
  assert.equal(sessionResult.headers["x-correlation-id"], "corr-session-1234");

  const metrics = response();
  await handler(request("GET", "/api/v1/observability/metrics"), metrics);
  const result = await metrics.done;
  assert.equal(result.status, 200);
  assert.equal(result.body.metrics.counters.some(counter => counter.name === "http_requests_total" && counter.labels.route === "/api/v1/session"), true);
  assert.equal(JSON.stringify(result.body).includes("cookie"), false);
  assert.equal(JSON.stringify(result.body).includes("Bearer"), false);
  rmSync(directory, { recursive: true, force: true });
});
