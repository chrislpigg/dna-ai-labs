import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("intake page exposes accessible save and resume draft controls", () => {
  assert.match(index, /id="draft-panel"[\s\S]*aria-labelledby="draft-panel-title"/);
  assert.match(index, /id="draft-list"[\s\S]*aria-live="polite"/);
  assert.match(index, /id="draft-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  assert.match(index, /type="button" data-save-draft>Save draft/);
});

test("draft UI uses server draft endpoints without submitting required intake fields", () => {
  assert.match(app, /api\("\/api\/v1\/intake-drafts"\)/);
  assert.match(app, /api\(`\/api\/v1\/intake-drafts\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(app, /api\(`\/api\/v1\/intake-drafts\/\$\{encodeURIComponent\(activeDraftId\)\}\/submit`, \{ method: "POST" \}\)/);
  assert.match(app, /api\(path, \{ method: activeDraftId \? "PATCH" : "POST"/);
  assert.match(app, /intakePayloadFromForm\(document\.querySelector\("#intake-form"\), \{ draft: true \}\)/);
});

test("draft content is not requested or rendered for roles outside draft permissions", () => {
  assert.match(app, /const draftRoles = new Set\(\["employee", "submitter", "project-lead", "lab-lead", "admin"\]\)/);
  assert.match(app, /if \(!canUseDrafts\(\)\) \{[\s\S]*intakeDrafts = \[\];[\s\S]*activeDraftId = null;[\s\S]*return;/);
  assert.match(app, /document\.querySelector\("\[data-save-draft\]"\)\.hidden = !canUseDrafts\(\)/);
});
