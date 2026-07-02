import { Pool } from "pg";
import { WorkflowError } from "./workflow-policy.mjs";

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const routeStaticSegments = new Set([
  "api", "v1", "cycles", "feature-flags", "role-assignments", "fellow-assignments", "manager-acknowledgement",
  "intake-drafts", "submit", "intakes", "triage-comments", "request-information", "resubmit", "revisions", "compare",
  "withdraw", "collaborators", "projects", "restore", "select", "start-incubation", "adoption", "acknowledge",
  "evidence", "delivery-kit", "work-item", "refresh", "metric-plan", "calendar-events", "reviews", "gates",
  "handoff", "accept", "decision-requests", "decisions", "approvals", "finalize"
]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function writeRouteKey(method, path) {
  const verb = String(method || "").toUpperCase();
  if (!mutatingMethods.has(verb)) return null;
  const route = String(path || "/").split("/").filter(Boolean).map(segment => routeStaticSegments.has(segment) ? segment : ":id").join("/");
  return `${verb}:/${route}`;
}

export class InMemoryRateLimitStore {
  constructor() {
    this.counters = new Map();
  }

  async increment({ organizationId, actorId, routeKey, windowStart, expiresAt }) {
    const key = `${organizationId}:${actorId}:${routeKey}:${windowStart}`;
    const existing = this.counters.get(key);
    const next = existing ? { count: existing.count + 1, expiresAt } : { count: 1, expiresAt };
    this.counters.set(key, next);
    return next.count;
  }
}

export class PostgresRateLimitStore {
  constructor(queryable) {
    this.queryable = queryable;
  }

  async increment({ organizationId, actorId, routeKey, windowStart, expiresAt }) {
    const result = await this.queryable.query(`
      INSERT INTO rate_limit_counters (organization_id, actor_id, route_key, window_start, count, expires_at)
      VALUES ($1, $2, $3, $4, 1, $5)
      ON CONFLICT (organization_id, actor_id, route_key, window_start)
      DO UPDATE SET count = rate_limit_counters.count + 1, expires_at = EXCLUDED.expires_at
      RETURNING count
    `, [organizationId, actorId, routeKey, new Date(windowStart).toISOString(), new Date(expiresAt).toISOString()]);
    return Number(result.rows[0]?.count || 0);
  }
}

export class FixedWindowRateLimiter {
  constructor({ store, limit = 30, windowSeconds = 60, clock = () => Date.now() } = {}) {
    if (!store || typeof store.increment !== "function") throw new TypeError("Rate limiter store must implement increment.");
    this.store = store;
    this.limit = positiveInteger(limit, 30);
    this.windowSeconds = positiveInteger(windowSeconds, 60);
    this.clock = clock;
  }

  async check({ method, path, organizationId, actorId } = {}) {
    const routeKey = writeRouteKey(method, path);
    if (!routeKey) return { limited: false };
    const tenant = String(organizationId || "").trim();
    const actor = String(actorId || "").trim();
    if (!tenant || !actor) throw new WorkflowError("RATE_LIMIT_IDENTITY_REQUIRED", "Rate limiting requires tenant and actor identity.", 503);
    const windowMs = this.windowSeconds * 1000;
    const now = this.clock();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs;
    const count = await this.store.increment({ organizationId: tenant, actorId: actor, routeKey, windowStart, expiresAt });
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    if (count > this.limit) {
      throw new WorkflowError("RATE_LIMITED", "Too many write requests. Retry after the rate-limit window resets.", 429, {
        retryAfterSeconds,
        limit: this.limit,
        windowSeconds: this.windowSeconds
      });
    }
    return { limited: false, limit: this.limit, remaining: Math.max(0, this.limit - count), retryAfterSeconds };
  }
}

export function createWriteRateLimiter({ env = process.env, demoMode = false, databaseUrl } = {}) {
  const limit = positiveInteger(env.LABS_WRITE_RATE_LIMIT_MAX, 30);
  const windowSeconds = positiveInteger(env.LABS_WRITE_RATE_LIMIT_WINDOW_SECONDS, 60);
  if (demoMode) return new FixedWindowRateLimiter({ store: new InMemoryRateLimitStore(), limit, windowSeconds });
  if (env.LABS_RATE_LIMIT_STORE === "postgres" && databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    const limiter = new FixedWindowRateLimiter({ store: new PostgresRateLimitStore(pool), limit, windowSeconds });
    limiter.close = () => pool.end();
    return limiter;
  }
  return {
    async check() {
      throw new WorkflowError("RATE_LIMIT_CONFIGURATION_INVALID", "Write rate limiting is not configured for production.", 503);
    },
    close() {}
  };
}
