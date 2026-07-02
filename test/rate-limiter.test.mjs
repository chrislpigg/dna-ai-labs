import test from "node:test";
import assert from "node:assert/strict";
import { FixedWindowRateLimiter, InMemoryRateLimitStore, PostgresRateLimitStore, writeRouteKey } from "../src/rate-limiter.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

test("write route keys normalize record identifiers but skip safe methods", () => {
  assert.equal(writeRouteKey("GET", "/api/v1/projects/project-1/select"), null);
  assert.equal(writeRouteKey("POST", "/api/v1/projects/project-1/select"), "POST:/api/v1/projects/:id/select");
  assert.equal(writeRouteKey("PUT", "/api/v1/projects/project-1/delivery-kit/architecture"), "PUT:/api/v1/projects/:id/delivery-kit/:id");
});

test("fixed-window rate limiter is tenant and actor aware and reports retry guidance", async () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({
    store: new InMemoryRateLimitStore(),
    limit: 2,
    windowSeconds: 10,
    clock: () => now
  });

  await limiter.check({ method: "POST", path: "/api/v1/intakes", organizationId: "org-a", actorId: "user-1" });
  const second = await limiter.check({ method: "POST", path: "/api/v1/intakes", organizationId: "org-a", actorId: "user-1" });
  assert.equal(second.remaining, 0);
  await assert.rejects(
    () => limiter.check({ method: "POST", path: "/api/v1/intakes", organizationId: "org-a", actorId: "user-1" }),
    error => error instanceof WorkflowError
      && error.code === "RATE_LIMITED"
      && error.status === 429
      && error.details.retryAfterSeconds === 9
      && error.details.limit === 2
  );

  await assert.doesNotReject(() => limiter.check({ method: "POST", path: "/api/v1/intakes", organizationId: "org-a", actorId: "user-2" }));
  await assert.doesNotReject(() => limiter.check({ method: "POST", path: "/api/v1/intakes", organizationId: "org-b", actorId: "user-1" }));
  now = 11_000;
  await assert.doesNotReject(() => limiter.check({ method: "POST", path: "/api/v1/intakes", organizationId: "org-a", actorId: "user-1" }));
});

test("PostgreSQL rate-limit store increments with an atomic upsert", async () => {
  const calls = [];
  const store = new PostgresRateLimitStore({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ count: 3 }] };
    }
  });
  const count = await store.increment({
    organizationId: "org-a",
    actorId: "user-1",
    routeKey: "POST:/api/v1/intakes",
    windowStart: Date.parse("2026-07-02T00:00:00.000Z"),
    expiresAt: Date.parse("2026-07-02T00:01:00.000Z")
  });

  assert.equal(count, 3);
  assert.match(calls[0].sql, /ON CONFLICT \(organization_id, actor_id, route_key, window_start\)/);
  assert.match(calls[0].sql, /DO UPDATE SET count = rate_limit_counters\.count \+ 1/);
  assert.deepEqual(calls[0].params.slice(0, 3), ["org-a", "user-1", "POST:/api/v1/intakes"]);
});
