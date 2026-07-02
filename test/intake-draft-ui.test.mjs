import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

function selectMarkup(name) {
  const match = index.match(new RegExp(`<select required name="${name}" data-person-select>[\\s\\S]*?<\\/select>`));
  assert.ok(match, `missing ${name} picker select`);
  return match[0];
}

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

test("cycle administration UI is accessible and hidden from non-admin roles", () => {
  assert.match(index, /id="cycle-admin-nav"[\s\S]*hidden/);
  assert.match(index, /id="cycles"[\s\S]*aria-label="Cycle administration"/);
  assert.match(index, /id="cycle-status"[\s\S]*role="alert"[\s\S]*aria-live="assertive"/);
  assert.match(index, /id="cycle-validation"[\s\S]*class="validation-summary"[\s\S]*tabindex="-1"[\s\S]*hidden/);
  assert.match(index, /id="cycle-list"[\s\S]*aria-live="polite"/);
  assert.match(index, /id="cycle-form"[\s\S]*novalidate/);
  assert.match(app, /function canAdminCycles\(\) \{ return currentUser\?\.role === "admin"; \}/);
  assert.match(app, /document\.querySelector\("#cycle-admin-nav"\)\.hidden = !canAdminCycles\(\)/);
  assert.match(app, /api\("\/api\/v1\/cycles"\)/);
  assert.match(app, /api\(path, \{ method: editingCycleId \? "PATCH" : "POST"/);
});

test("intake person fields use directory-backed search instead of hard-coded user options", () => {
  assert.match(index, /id="people-picker-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  assert.match(index, /class="person-search"[\s\S]*data-person-target="metricOwnerId"/);
  assert.match(index, /select required name="sponsorId" data-person-select/);
  assert.doesNotMatch(selectMarkup("sponsorId"), /<option value="executive-sponsor">Jordan Executive Sponsor<\/option>/);
  assert.doesNotMatch(selectMarkup("receivingOwnerId"), /<option value="receiving-owner">Riley Receiving Owner<\/option>/);
  assert.match(app, /api\(`\/api\/v1\/directory\/people\?q=\$\{encodeURIComponent\(query\)\}`\)/);
  assert.match(app, /No active people matched that search/);
  assert.match(app, /People search failed:/);
});

test("project brief renders directory organization context and warnings", () => {
  assert.match(app, /function assignmentSummary\(project, key, fallback = "Not assigned"\)/);
  assert.match(app, /function hasActiveDirectoryAssignment\(project, key\)/);
  assert.match(app, /directoryWarnings \|\| \[\]\)\.map\(warning => `<li><b>\$\{escapeHtml\(warning\.code\)\}<\/b>/);
  assert.match(app, /Metric owner<\/dt><dd>\$\{escapeHtml\(assignmentSummary\(project, "metricOwner"\)\)\}/);
  assert.match(app, /Receiving owner<\/dt><dd>\$\{escapeHtml\(assignmentSummary\(project, "receivingOwner"\)\)\}/);
  assert.match(app, /Directory warnings/);
});

test("project brief renders an editable delivery-kit workspace", () => {
  assert.match(app, /function renderDeliveryKit\(project\)/);
  assert.match(app, /Transfer-readiness gaps:/);
  assert.match(app, /aria-label="Delivery kit workspace"/);
  assert.match(app, /data-delivery-status/);
  assert.match(app, /data-delivery-owner/);
  assert.match(app, /data-delivery-evidence/);
  assert.match(app, /data-delivery-save/);
  assert.match(app, /data-delivery-reset/);
  assert.match(app, /acceptedAt \? new Intl\.DateTimeFormat/);
  assert.match(app, /\/delivery-kit\/\$\{encodeURIComponent\(itemKey\)\}`/);
});

test("project brief renders Fellow assignment and manager acknowledgement views", () => {
  assert.match(app, /let fellowAssignments = \[\]/);
  assert.match(app, /\/api\/v1\/fellow-assignments/);
  assert.match(app, /function renderFellowAssignments\(project\)/);
  assert.match(app, /aria-label="Fellow assignments"/);
  assert.match(app, /No Fellow assignments for this project/);
  assert.match(app, /Fellow assignments unavailable:/);
  assert.match(app, /data-fellow-create/);
  assert.match(app, /data-fellow-ack/);
  assert.match(app, /managerAcknowledgedAt/);
  assert.match(app, /Capacity and manager acknowledgements/);
});
