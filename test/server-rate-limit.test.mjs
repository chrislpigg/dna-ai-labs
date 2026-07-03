import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function request(method, url, body = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", "x-labs-actor": "submitter-1", "content-type": "application/json" };
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

test("write endpoints return structured 429 responses with retry guidance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-rate-server-"));
  process.env.VERCEL = "1";
  process.env.LABS_DEMO_MODE = "true";
  process.env.LABS_DB_PATH = join(directory, "labs.sqlite");
  process.env.LABS_WRITE_RATE_LIMIT_MAX = "1";
  process.env.LABS_WRITE_RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.LABS_OBSERVABILITY_EXPORTER = "otlp";
  const { handler } = await import(`../server.mjs?rate-limit-test=${Date.now()}`);

  const payload = { content: { title: "Rate limited draft" } };
  const first = response();
  await handler(request("POST", "/api/v1/intake-drafts", payload), first);
  assert.equal((await first.done).status, 201);

  const second = response();
  await handler(request("POST", "/api/v1/intake-drafts", payload), second);
  const limited = await second.done;
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) >= 1 && Number(limited.headers["retry-after"]) <= 60);
  assert.equal(limited.body.error.code, "RATE_LIMITED");
  assert.equal(limited.body.error.details.limit, 1);
  assert.equal(limited.body.error.details.windowSeconds, 60);
  assert.equal(JSON.stringify(limited.body).includes("Rate limited draft"), false);
  rmSync(directory, { recursive: true, force: true });
});
