import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

function assertControlLabel(name) {
  assert.match(index, new RegExp(`<label[\\s\\S]{0,240}name="${name}"`), `${name} should be wrapped in a visible label`);
}

test("intake flow keeps required controls labeled and status updates announced", () => {
  assert.match(index, /<html lang="en">/);
  assert.match(index, /<section id="intake" class="view" aria-label="New project intake">/);
  assert.match(index, /id="draft-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  assert.match(index, /id="people-picker-status"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  for (const name of ["title", "originTeam", "problem", "users", "reach", "metric", "baseline", "target", "metricSource", "metricOwnerId", "sponsorId", "receivingOwnerId", "projectLeadId", "risk", "transfer", "adoption", "evidence"]) {
    assertControlLabel(name);
  }
  assert.match(index, /class="person-search"[\s\S]*aria-describedby="people-picker-status"/);
  assert.match(app, /document\.querySelector\("input\[name=title\]"\)\.focus\(\)/);
  assert.match(app, /setDraftStatus\(`Draft could not be saved: \$\{error\.message\}`, "error"\)/);
});

test("decision flow exposes modal names, keyboard controls, approval comments, and live feedback", () => {
  assert.match(index, /<dialog id="project-dialog" aria-labelledby="dialog-title">/);
  assert.match(index, /class="dialog-close" aria-label="Close details"/);
  assert.match(index, /id="toast"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  assert.match(app, /document\.querySelector\("#project-dialog"\)\.showModal\(\)/);
  assert.match(app, /if \(event\.target\.closest\("\.dialog-close"\)\) document\.querySelector\("#project-dialog"\)\.close\(\)/);
  assert.match(app, /<label class="decision-rationale">Decision rationale<textarea id="decision-rationale"/);
  assert.match(app, /<label>Approval comment<textarea id="approval-comment"/);
  assert.match(app, /data-approval="approved"/);
  assert.match(app, /data-approval="rejected"/);
  assert.match(app, /pending\.requiredApprovers\.includes\(currentUser\?\.role\)[\s\S]*pending\.requestedBy !== currentUser\?\.id/);
  assert.match(app, /Final decisions are disabled until independent approvals and required gates are complete/);
});

test("review flow has labeled evidence inputs, approved-link prompts, and non-modal announcements", () => {
  assert.match(app, /<section class="review-summary"><p class="eyebrow">Required reviews<\/p>/);
  assert.match(app, /<div class="review-editor"><p>Complete required review<\/p>/);
  assert.match(app, /data-review-link="\$\{escapeHtml\(review\.reviewType\)\}" type="url" placeholder="https:\/\/intranet\.example\/review"/);
  assert.match(app, /data-complete-review="\$\{escapeHtml\(review\.reviewType\)\}">Mark complete/);
  assert.match(app, /if \(!evidenceLink\) return showToast\("Add an approved review link before completing this review\."\)/);
  assert.match(app, /\/reviews\/\$\{encodeURIComponent\(reviewType\)\}`/);
  assert.match(app, /showToast\("Required review completed and added to the audit trail\."\)/);
});

test("critical keyboard affordances avoid focus traps and preserve visible focus", () => {
  assert.doesNotMatch(index + app, /tabindex="[1-9]/);
  assert.doesNotMatch(index + app, /onclick="/);
  assert.match(styles, /button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,\[tabindex="-1"\]:focus-visible/);
  assert.match(styles, /outline:3px solid #245b70/);
  assert.match(styles, /outline-offset:3px/);
});
