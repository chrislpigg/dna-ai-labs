import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WorkflowError } from "./workflow-policy.mjs";

const now = () => new Date().toISOString();

function cleanText(value, { field, max, required = true }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new WorkflowError("INVALID_INPUT", `${field} is required.`, 400);
    return "";
  }
  if (text.length > max) throw new WorkflowError("INVALID_INPUT", `${field} is too long.`, 400);
  return text;
}

function cleanUrl(value) {
  const text = cleanText(value, { field: "Link", max: 500 });
  let url;
  try { url = new URL(text); } catch { throw new WorkflowError("INVALID_INPUT", "Link must be a valid URL.", 400); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WorkflowError("INVALID_INPUT", "Link must be an http(s) URL.", 400);
  }
  return url.toString();
}

const seedTools = [
  ["Release Readiness Assistant", "Summarizes open risks before a release cut.", "Pulls open incidents, failing checks, and unmerged blockers into one go/no-go summary so release captains stop chasing status in five tabs.", "https://intranet.example/tools/release-readiness", "accessibility-lead", "Avery Accessibility"],
  ["Accessibility Linter Bot", "Flags WCAG issues inline on every pull request.", "Runs an automated contrast, focus-order, and semantic-markup pass on changed components and comments the findings directly on the PR.", "https://intranet.example/tools/a11y-linter", "ube-lead", "Uma UBE"],
  ["Meeting Notes Distiller", "Turns a recording into decisions and action items.", "Drops a transcript in, gets back the decisions made, who owns each follow-up, and the open questions — nothing else.", "https://intranet.example/tools/notes-distiller", "submitter-1", "Taylor Submitter"]
];

/** Lightweight internal tool catalog: browse, upvote, and comment. Demo and tests only. */
export class LabsCatalog {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
    this.seed();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        builder_id TEXT NOT NULL,
        builder_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_votes (
        tool_id TEXT NOT NULL REFERENCES catalog_tools(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tool_id, actor_id)
      );
      CREATE TABLE IF NOT EXISTS catalog_comments (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL REFERENCES catalog_tools(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_comments_tool ON catalog_comments (tool_id, created_at);
    `);
  }

  seed() {
    if (this.db.prepare("SELECT COUNT(*) AS count FROM catalog_tools").get().count > 0) return;
    const insert = this.db.prepare("INSERT INTO catalog_tools (id, name, tagline, description, url, builder_id, builder_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertVote = this.db.prepare("INSERT INTO catalog_votes (tool_id, actor_id, created_at) VALUES (?, ?, ?)");
    seedTools.forEach((tool, index) => {
      const id = `tool-seed-${index + 1}`;
      const created = new Date(Date.UTC(2026, 5, 20 + index, 12)).toISOString();
      insert.run(id, ...tool, created);
      for (let vote = 0; vote < (seedTools.length - index) * 3; vote += 1) {
        insertVote.run(id, `seed-voter-${index}-${vote}`, created);
      }
    });
  }

  tool(id) {
    const row = this.db.prepare("SELECT * FROM catalog_tools WHERE id = ?").get(id);
    if (!row) throw new WorkflowError("NOT_FOUND", "Tool not found.", 404);
    return row;
  }

  serialize(row, actorId) {
    const votes = this.db.prepare("SELECT COUNT(*) AS count FROM catalog_votes WHERE tool_id = ?").get(row.id).count;
    const comments = this.db.prepare("SELECT COUNT(*) AS count FROM catalog_comments WHERE tool_id = ?").get(row.id).count;
    const hasVoted = actorId ? Boolean(this.db.prepare("SELECT 1 FROM catalog_votes WHERE tool_id = ? AND actor_id = ?").get(row.id, actorId)) : false;
    return {
      id: row.id,
      name: row.name,
      tagline: row.tagline,
      description: row.description,
      url: row.url,
      builder: { id: row.builder_id, name: row.builder_name },
      createdAt: row.created_at,
      votes,
      comments,
      hasVoted
    };
  }

  listTools(actorId, sort = "top") {
    const order = sort === "new"
      ? "created_at DESC"
      : "votes DESC, created_at DESC";
    const rows = this.db.prepare(`
      SELECT catalog_tools.*, (SELECT COUNT(*) FROM catalog_votes WHERE catalog_votes.tool_id = catalog_tools.id) AS votes
      FROM catalog_tools ORDER BY ${order}
    `).all();
    return rows.map(row => this.serialize(row, actorId));
  }

  addTool(actor, input = {}) {
    const tool = {
      id: randomUUID(),
      name: cleanText(input.name, { field: "Name", max: 120 }),
      tagline: cleanText(input.tagline, { field: "Tagline", max: 160 }),
      description: cleanText(input.description, { field: "Description", max: 2000, required: false }),
      url: cleanUrl(input.url),
      builderId: actor.id,
      builderName: cleanText(input.builderName, { field: "Your name", max: 80, required: false }) || actor.name || "Anonymous",
      createdAt: now()
    };
    this.db.prepare("INSERT INTO catalog_tools (id, name, tagline, description, url, builder_id, builder_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(tool.id, tool.name, tool.tagline, tool.description, tool.url, tool.builderId, tool.builderName, tool.createdAt);
    return this.serialize(this.tool(tool.id), actor.id);
  }

  toggleVote(actor, toolId) {
    this.tool(toolId);
    const existing = this.db.prepare("SELECT 1 FROM catalog_votes WHERE tool_id = ? AND actor_id = ?").get(toolId, actor.id);
    if (existing) {
      this.db.prepare("DELETE FROM catalog_votes WHERE tool_id = ? AND actor_id = ?").run(toolId, actor.id);
    } else {
      this.db.prepare("INSERT INTO catalog_votes (tool_id, actor_id, created_at) VALUES (?, ?, ?)").run(toolId, actor.id, now());
    }
    return this.serialize(this.tool(toolId), actor.id);
  }

  listComments(toolId) {
    this.tool(toolId);
    return this.db.prepare("SELECT id, actor_id AS actorId, actor_name AS author, body, created_at AS createdAt FROM catalog_comments WHERE tool_id = ? ORDER BY created_at ASC").all(toolId);
  }

  addComment(actor, toolId, input = {}) {
    this.tool(toolId);
    const body = cleanText(input.body, { field: "Comment", max: 2000 });
    const author = cleanText(input.author, { field: "Your name", max: 80, required: false }) || actor.name || "Anonymous";
    const comment = { id: randomUUID(), actorId: actor.id, author, body, createdAt: now() };
    this.db.prepare("INSERT INTO catalog_comments (id, tool_id, actor_id, actor_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(comment.id, toolId, comment.actorId, comment.author, comment.body, comment.createdAt);
    return { comment, comments: this.listComments(toolId) };
  }

  health() {
    try { return this.db.prepare("SELECT 1 AS ok").get().ok === 1; } catch { return false; }
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}
