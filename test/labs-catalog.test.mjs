import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabsCatalog } from "../src/labs-catalog.mjs";
import { WorkflowError } from "../src/workflow-policy.mjs";

function createCatalog() {
  const directory = mkdtempSync(join(tmpdir(), "dna-ai-labs-catalog-"));
  const catalog = new LabsCatalog(join(directory, "catalog.sqlite"));
  return { catalog, dispose: () => { catalog.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const alice = { id: "alice", name: "Alice Builder" };
const bob = { id: "bob", name: "Bob Reviewer" };

test("catalog seeds tools and sorts by votes for the Top view", () => {
  const { catalog, dispose } = createCatalog();
  try {
    const tools = catalog.listTools(alice.id, "top");
    assert.ok(tools.length >= 3);
    for (let i = 1; i < tools.length; i += 1) {
      assert.ok(tools[i - 1].votes >= tools[i].votes, "tools are ordered by descending votes");
    }
  } finally { dispose(); }
});

test("adding a tool validates input and appears newest-first", () => {
  const { catalog, dispose } = createCatalog();
  try {
    const created = catalog.addTool(alice, { name: "My Tool", tagline: "Does a thing", url: "https://intranet.example/my-tool" });
    assert.equal(created.name, "My Tool");
    assert.equal(created.votes, 0);
    assert.equal(created.builder.name, "Alice Builder");
    const newest = catalog.listTools(alice.id, "new");
    assert.equal(newest[0].id, created.id);

    assert.throws(() => catalog.addTool(alice, { name: "", tagline: "x", url: "https://intranet.example/x" }), WorkflowError);
    assert.throws(() => catalog.addTool(alice, { name: "ok", tagline: "x", url: "not-a-url" }), WorkflowError);
    assert.throws(() => catalog.addTool(alice, { name: "ok", tagline: "x", url: "ftp://intranet.example/x" }), WorkflowError);
  } finally { dispose(); }
});

test("voting toggles once per actor and is not double-counted", () => {
  const { catalog, dispose } = createCatalog();
  try {
    const tool = catalog.addTool(alice, { name: "Votable", tagline: "t", url: "https://intranet.example/v" });
    let state = catalog.toggleVote(bob, tool.id);
    assert.equal(state.votes, 1);
    assert.equal(state.hasVoted, true);
    // Same actor voting again does not stack — it retracts.
    state = catalog.toggleVote(bob, tool.id);
    assert.equal(state.votes, 0);
    assert.equal(state.hasVoted, false);
    // Distinct actors each add one.
    catalog.toggleVote(alice, tool.id);
    state = catalog.toggleVote(bob, tool.id);
    assert.equal(state.votes, 2);
  } finally { dispose(); }
});

test("comments are stored per tool in order and count on the card", () => {
  const { catalog, dispose } = createCatalog();
  try {
    const tool = catalog.addTool(alice, { name: "Commentable", tagline: "t", url: "https://intranet.example/c" });
    catalog.addComment(bob, tool.id, { body: "First impression: useful." });
    const { comments } = catalog.addComment(alice, tool.id, { body: "Thanks — shipping v2 soon." });
    assert.equal(comments.length, 2);
    assert.equal(comments[0].author, "Bob Reviewer");
    assert.equal(comments[1].body, "Thanks — shipping v2 soon.");
    assert.equal(catalog.listTools(alice.id, "top").find(item => item.id === tool.id).comments, 2);
    assert.throws(() => catalog.addComment(bob, tool.id, { body: "   " }), WorkflowError);
    assert.throws(() => catalog.addComment(bob, "missing-tool", { body: "hi" }), WorkflowError);
  } finally { dispose(); }
});
