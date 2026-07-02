let projects = [];
let currentFilter = "all";
let activeProjectId = null;
let currentUser = null;
let demoMode = false;
let demoActorId = "lab-lead";
let auditLoaded = false;
let intakeDrafts = [];
let activeDraftId = null;
let cycles = [];
let editingCycleId = null;
let fellowAssignments = [];
let fellowAssignmentError = "";

const activeStages = new Set(["Selected", "Incubating", "Decision pending"]);
const candidateStages = new Set(["Draft", "Submitted", "Triage"]);
const draftRoles = new Set(["employee", "submitter", "project-lead", "lab-lead", "admin"]);

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
}

function stageClass(stage) { return String(stage).replaceAll(" ", "-"); }
function getProject(id) { return projects.find(project => project.id === id); }
function formatDate(value) { return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "Not set"; }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not verified"; }
function directoryAssignment(project, key) { return project.directoryAssignments?.[key] || null; }
function assignmentHolder(project, key) {
  return key === "metricOwner" ? project.metricOwner : project[key];
}
function assignmentSummary(project, key, fallback = "Not assigned") {
  const assignment = directoryAssignment(project, key);
  const holder = assignmentHolder(project, key);
  if (!assignment && !holder) return fallback;
  const name = assignment?.displayName || holder?.name || holder?.id || assignment?.id;
  const organization = assignment?.organization ? ` · ${assignment.organization}` : "";
  const manager = assignment?.managerId ? ` · manager ${assignment.managerId}` : "";
  const status = assignment ? ` · ${assignment.active ? "active" : "inactive"}` : " · directory unverified";
  return `${name}${organization}${manager}${status}`;
}
function hasActiveDirectoryAssignment(project, key) {
  return directoryAssignment(project, key)?.active === true;
}
function directoryWarningList(project) {
  return (project.directoryWarnings || []).map(warning => `<li><b>${escapeHtml(warning.code)}</b> · ${escapeHtml(warning.assignment)} · ${escapeHtml(warning.userId)}</li>`).join("");
}
function canViewIntegrationDiagnostics() { return ["lab-lead", "admin"].includes(currentUser?.role); }
function verificationLabel(status) { return status === "verified" ? "Verified" : "Unverified"; }
function verificationClass(status) { return status === "verified" ? "is-verified" : "is-unverified"; }
function artifactIntegrationRows(project) {
  const rows = [];
  (project.evidence || []).forEach(entry => rows.push({ label: `Evidence · ${entry.evidenceType?.replaceAll("_", " ")}`, link: entry.sourceLink, status: entry.artifactVerificationStatus, at: entry.artifactVerifiedAt }));
  (project.reviews || []).filter(review => review.evidenceLink).forEach(review => rows.push({ label: `Review · ${review.reviewType?.replaceAll("_", " ")}`, link: review.evidenceLink, status: review.artifactVerificationStatus, at: review.artifactVerifiedAt }));
  (project.gates || []).filter(gate => gate.evidenceLink).forEach(gate => rows.push({ label: `Gate · ${gate.key?.replaceAll("_", " ")}`, link: gate.evidenceLink, status: gate.artifactVerificationStatus, at: gate.artifactVerifiedAt }));
  (project.deliveryKit || []).filter(item => item.evidenceLink).forEach(item => rows.push({ label: `Delivery · ${deliveryKitLabel(item.itemKey)}`, link: item.evidenceLink, status: item.artifactVerificationStatus, at: item.artifactVerifiedAt }));
  if (project.handoff?.adoptionPlanLink) rows.push({ label: "Handoff · adoption plan", link: project.handoff.adoptionPlanLink, status: project.handoff.artifactVerificationStatus, at: project.handoff.artifactVerifiedAt });
  return rows;
}
function renderIntegrationStatus(project) {
  const diagnostics = canViewIntegrationDiagnostics();
  const artifacts = artifactIntegrationRows(project);
  const verifiedArtifacts = artifacts.filter(row => row.status === "verified").length;
  const work = project.workItem;
  const calendarEvents = project.calendarEvents || [];
  return `<section class="integration-status" aria-label="Integration status">
    <div class="delivery-kit-heading"><p class="eyebrow">Integrations</p><p>${verifiedArtifacts}/${artifacts.length || 0} artifact link${artifacts.length === 1 ? "" : "s"} verified</p></div>
    <div class="integration-grid">
      <article class="integration-item">
        <h4>Artifact links</h4>
        ${artifacts.length ? `<ul>${artifacts.map(row => `<li><span>${escapeHtml(row.label)}</span><a href="${escapeHtml(row.link)}" target="_blank" rel="noreferrer">Open</a><b class="${verificationClass(row.status)}">${verificationLabel(row.status)}</b><small>${escapeHtml(formatDateTime(row.at))}</small>${row.status !== "verified" ? `<em>Needs verification before it should be treated as complete.</em>` : ""}</li>`).join("")}</ul>` : `<p class="empty-state" role="status">No approved artifact links recorded.</p>`}
      </article>
      <article class="integration-item">
        <h4>Work tracking</h4>
        ${work ? `<dl><div><dt>Status</dt><dd>${escapeHtml(work.externalStatus)}</dd></div><div><dt>Last verified</dt><dd>${escapeHtml(formatDateTime(work.lastVerifiedAt))}</dd></div>${diagnostics ? `<div><dt>Provider ref</dt><dd>${escapeHtml(work.provider)} · ${escapeHtml(work.externalRef)}</dd></div>` : ""}</dl>` : `<p class="empty-state" role="status">No verified work item linked.</p>`}
      </article>
      <article class="integration-item">
        <h4>Calendar</h4>
        ${calendarEvents.length ? `<ul>${calendarEvents.map(event => `<li><span>${escapeHtml(event.eventType.replaceAll("_", " "))}</span>${event.externalUrl ? `<a href="${escapeHtml(event.externalUrl)}" target="_blank" rel="noreferrer">Open</a>` : ""}<b class="is-verified">Verified</b><small>${escapeHtml(formatDateTime(event.lastVerifiedAt))}</small>${diagnostics ? `<em>${escapeHtml(event.provider)} · ${escapeHtml(event.externalRef)}</em>` : ""}</li>`).join("")}</ul>` : `<p class="empty-state" role="status">No verified calendar events scheduled.</p>`}
      </article>
    </div>
  </section>`;
}
function deliveryKitLabel(key) { return String(key).replaceAll("_", " "); }
function canEditDeliveryKit(project) {
  return ["lab-lead", "admin"].includes(currentUser?.role) || (currentUser?.role === "project-lead" && project.projectLead?.id === currentUser.id);
}
function renderDeliveryKit(project) {
  const items = project.deliveryKit || [];
  const editable = canEditDeliveryKit(project);
  const gaps = items.filter(item => item.status !== "complete").map(item => deliveryKitLabel(item.itemKey));
  const gapCopy = gaps.length ? `Transfer-readiness gaps: ${gaps.join(", ")}.` : "Transfer-readiness kit is complete.";
  const ownerOptions = [
    project.projectLead?.id,
    project.receivingOwner?.id,
    project.sponsor?.id,
    project.metricOwnerId
  ].filter(Boolean);
  return `<section class="delivery-kit-workspace" aria-label="Delivery kit workspace">
    <div class="delivery-kit-heading"><p class="eyebrow">Delivery kit</p><p class="${gaps.length ? "is-gap" : "is-complete"}">${escapeHtml(gapCopy)}</p></div>
    <div class="delivery-kit-grid">${items.map(item => {
      const label = deliveryKitLabel(item.itemKey);
      const statusId = `delivery-status-${item.itemKey}`;
      const ownerId = `delivery-owner-${item.itemKey}`;
      const evidenceId = `delivery-evidence-${item.itemKey}`;
      const accepted = item.acceptedAt ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(item.acceptedAt)) : "Not accepted";
      return `<article class="delivery-kit-item" data-delivery-item="${escapeHtml(item.itemKey)}">
        <div><h4>${escapeHtml(label)}</h4><span class="delivery-status status-${escapeHtml(item.status)}">${escapeHtml(item.status.replaceAll("_", " "))}</span></div>
        <dl><div><dt>Owner</dt><dd>${escapeHtml(item.ownerId || "Unassigned")}</dd></div><div><dt>Evidence</dt><dd>${item.evidenceLink ? `<a href="${escapeHtml(item.evidenceLink)}" target="_blank" rel="noreferrer">${escapeHtml(verificationLabel(item.artifactVerificationStatus))} link</a>` : "Missing"}</dd></div><div><dt>Accepted</dt><dd>${escapeHtml(accepted)}</dd></div></dl>
        ${editable ? `<div class="delivery-kit-editor">
          <label for="${statusId}">Status<select id="${statusId}" data-delivery-status><option value="not_started" ${item.status === "not_started" ? "selected" : ""}>Not started</option><option value="in_progress" ${item.status === "in_progress" ? "selected" : ""}>In progress</option><option value="complete" ${item.status === "complete" ? "selected" : ""}>Complete</option></select></label>
          <label for="${ownerId}">Owner<input id="${ownerId}" data-delivery-owner list="delivery-owner-options" value="${escapeHtml(item.ownerId || project.projectLead?.id || "")}" /></label>
          <label for="${evidenceId}">Evidence link<input id="${evidenceId}" data-delivery-evidence type="url" value="${escapeHtml(item.evidenceLink || "")}" placeholder="https://intranet.example/delivery-kit" /></label>
          <div class="delivery-kit-actions"><button class="decision-button" data-delivery-save="${escapeHtml(item.itemKey)}">Save</button><button class="decision-button" data-delivery-reset="${escapeHtml(item.itemKey)}">Reset</button></div>
        </div>` : ""}
      </article>`;
    }).join("")}</div>
    ${editable ? `<datalist id="delivery-owner-options">${ownerOptions.map(id => `<option value="${escapeHtml(id)}"></option>`).join("")}</datalist>` : ""}
  </section>`;
}
function canCreateFellowAssignments() { return ["lab-lead", "admin"].includes(currentUser?.role); }
function renderFellowAssignments(project) {
  const assignments = fellowAssignments.filter(assignment => assignment.projectId === project.id);
  const error = fellowAssignmentError ? `<p class="audit-error" role="status">Fellow assignments unavailable: ${escapeHtml(fellowAssignmentError)}</p>` : "";
  const empty = !assignments.length && !error ? `<p class="empty-state" role="status">No Fellow assignments for this project.</p>` : "";
  return `<section class="fellow-workspace" aria-label="Fellow assignments">
    <div class="delivery-kit-heading"><p class="eyebrow">Fellows</p><p>Capacity and manager acknowledgements</p></div>
    ${error || empty}
    ${assignments.length ? `<div class="fellow-list">${assignments.map(assignment => `<article class="fellow-item">
      <div><h4>${escapeHtml(assignment.fellowId)}</h4><span class="delivery-status status-${escapeHtml(assignment.status)}">${escapeHtml(assignment.status)}</span></div>
      <dl><div><dt>Project</dt><dd>${escapeHtml(project.title)}</dd></div><div><dt>Role</dt><dd>${escapeHtml(assignment.assignmentRole)}</dd></div><div><dt>Capacity</dt><dd>${escapeHtml(assignment.capacityUnits)} unit${Number(assignment.capacityUnits) === 1 ? "" : "s"}</dd></div><div><dt>Manager</dt><dd>${escapeHtml(assignment.managerId)}</dd></div><div><dt>Acknowledgement</dt><dd>${assignment.managerAcknowledgedAt ? escapeHtml(new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(assignment.managerAcknowledgedAt))) : "Pending"}</dd></div></dl>
      ${currentUser?.id === assignment.managerId && assignment.status === "proposed" ? `<button class="decision-button" data-fellow-ack="${escapeHtml(assignment.id)}">Acknowledge assignment</button>` : ""}
    </article>`).join("")}</div>` : ""}
    ${canCreateFellowAssignments() ? `<div class="fellow-editor">
      <p>Assign Fellow</p>
      <label>Fellow id<input id="fellow-id" placeholder="employee-1" /></label>
      <label>Role<input id="fellow-role" placeholder="Pilot builder" /></label>
      <label>Capacity units<input id="fellow-capacity" type="number" min="1" max="10" value="1" /></label>
      <button class="decision-button" data-fellow-create="${escapeHtml(project.id)}">Create assignment</button>
    </div>` : ""}
  </section>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { accept: "application/json", ...(demoMode ? { "x-labs-actor": demoActorId } : {}), ...(options.body ? { "content-type": "application/json" } : {}) },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "The request could not be completed.");
  return payload;
}

function canUseDrafts() { return draftRoles.has(currentUser?.role); }
function canAdminCycles() { return currentUser?.role === "admin"; }

function setPeopleStatus(message = "", tone = "info") {
  const status = document.querySelector("#people-picker-status");
  status.textContent = message;
  status.className = `form-status ${tone === "error" ? "is-error" : ""}`.trim();
}

function personLabel(person) {
  return `${person.displayName} · ${person.organization}`;
}

function ensurePersonOption(fieldName, id, label = id) {
  const select = document.querySelector(`select[name="${CSS.escape(fieldName)}"]`);
  if (!select || !id) return;
  if (![...select.options].some(option => option.value === id)) {
    select.add(new Option(label, id));
  }
  select.value = id;
}

function renderPeopleOptions(fieldName, people = []) {
  const select = document.querySelector(`select[name="${CSS.escape(fieldName)}"]`);
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${people.length ? "Select an active person" : "No active matches"}</option>`;
  for (const person of people) select.add(new Option(personLabel(person), person.id));
  if (current && people.some(person => person.id === current)) select.value = current;
}

async function searchPeopleForField(input) {
  const fieldName = input.dataset.personTarget;
  const query = input.value.trim();
  if (query.length < 2) {
    renderPeopleOptions(fieldName, []);
    setPeopleStatus("Enter at least two characters to search active people.");
    return;
  }
  setPeopleStatus("Searching active people...");
  try {
    const { people } = await api(`/api/v1/directory/people?q=${encodeURIComponent(query)}`);
    renderPeopleOptions(fieldName, people);
    setPeopleStatus(people.length ? `${people.length} active people found.` : "No active people matched that search.");
  } catch (error) {
    renderPeopleOptions(fieldName, []);
    setPeopleStatus(`People search failed: ${error.message}`, "error");
  }
}

function setDraftStatus(message = "", tone = "info") {
  const status = document.querySelector("#draft-status");
  status.textContent = message;
  status.className = `form-status ${tone === "error" ? "is-error" : ""}`.trim();
}

function intakePayloadFromForm(formElement, { draft = false } = {}) {
  const form = new FormData(formElement);
  const reach = String(form.get("reach") ?? "").trim();
  return {
    title: form.get("title"),
    originTeam: form.get("originTeam"),
    users: form.get("users"),
    potentialReach: draft && !reach ? "" : Number(reach),
    problem: form.get("problem"),
    metric: form.get("metric"),
    baseline: form.get("baseline"),
    target: form.get("target"),
    metricSource: form.get("metricSource"),
    metricOwnerId: form.get("metricOwnerId"),
    sponsorId: form.get("sponsorId"),
    receivingOwnerId: form.get("receivingOwnerId"),
    projectLeadId: form.get("projectLeadId"),
    riskClassification: form.get("risk"),
    transferDate: form.get("transfer"),
    adoptionGate: form.has("adoption"),
    evidenceGate: form.has("evidence")
  };
}

function fillIntakeForm(content = {}) {
  const form = document.querySelector("#intake-form");
  const fields = {
    title: content.title,
    originTeam: content.originTeam,
    problem: content.problem,
    users: content.users,
    reach: content.potentialReach,
    metric: content.metric,
    baseline: content.baseline,
    target: content.target,
    metricSource: content.metricSource,
    metricOwnerId: content.metricOwnerId,
    sponsorId: content.sponsorId,
    receivingOwnerId: content.receivingOwnerId,
    projectLeadId: content.projectLeadId,
    risk: content.riskClassification,
    transfer: content.transferDate
  };
  for (const [name, value] of Object.entries(fields)) {
    const field = form.elements.namedItem(name);
    if (field) field.value = value ?? "";
  }
  for (const name of ["metricOwnerId", "sponsorId", "receivingOwnerId", "projectLeadId"]) ensurePersonOption(name, content[name]);
  form.elements.namedItem("adoption").checked = Boolean(content.adoptionGate);
  form.elements.namedItem("evidence").checked = Boolean(content.evidenceGate);
}

function renderIntakeDrafts() {
  const panel = document.querySelector("#draft-panel");
  const list = document.querySelector("#draft-list");
  panel.hidden = !canUseDrafts();
  document.querySelector("[data-save-draft]").hidden = !canUseDrafts();
  if (!canUseDrafts()) {
    list.innerHTML = "";
    return;
  }
  if (!intakeDrafts.length) {
    list.innerHTML = `<p class="empty-state">No saved drafts yet.</p>`;
    return;
  }
  list.innerHTML = intakeDrafts.map(draft => {
    const title = draft.content?.title || "Untitled draft";
    const updated = draft.updatedAt ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(draft.updatedAt)) : "Not saved yet";
    return `<article class="draft-item ${draft.id === activeDraftId ? "active" : ""}">
      <div><h4>${escapeHtml(title)}</h4><p>Updated ${escapeHtml(updated)}</p></div>
      <button class="decision-button" type="button" data-draft="${escapeHtml(draft.id)}">Resume</button>
    </article>`;
  }).join("");
}

async function loadIntakeDrafts() {
  if (!canUseDrafts()) {
    if (activeDraftId) document.querySelector("#intake-form").reset();
    intakeDrafts = [];
    activeDraftId = null;
    renderIntakeDrafts();
    setDraftStatus("");
    return;
  }
  try {
    const { drafts } = await api("/api/v1/intake-drafts");
    intakeDrafts = drafts;
    renderIntakeDrafts();
  } catch (error) {
    intakeDrafts = [];
    renderIntakeDrafts();
    document.querySelector("#draft-list").innerHTML = `<p class="audit-error">${escapeHtml(error.message)}</p>`;
    setDraftStatus(`Drafts could not be loaded: ${error.message}`, "error");
  }
}

async function resumeIntakeDraft(id) {
  try {
    const { draft } = await api(`/api/v1/intake-drafts/${encodeURIComponent(id)}`);
    activeDraftId = draft.id;
    fillIntakeForm(draft.content);
    setDraftStatus(`Editing saved draft: ${draft.content?.title || "Untitled draft"}.`);
    renderIntakeDrafts();
    document.querySelector("input[name=title]").focus();
  } catch (error) {
    setDraftStatus(`Draft could not be resumed: ${error.message}`, "error");
    showToast(error.message);
  }
}

async function saveIntakeDraft() {
  if (!canUseDrafts()) return setDraftStatus("You do not have permission to save intake drafts.", "error");
  const button = document.querySelector("[data-save-draft]");
  button.disabled = true;
  setDraftStatus(activeDraftId ? "Saving draft changes..." : "Saving draft...");
  try {
    const payload = { content: intakePayloadFromForm(document.querySelector("#intake-form"), { draft: true }) };
    const path = activeDraftId ? `/api/v1/intake-drafts/${encodeURIComponent(activeDraftId)}` : "/api/v1/intake-drafts";
    const { draft } = await api(path, { method: activeDraftId ? "PATCH" : "POST", body: JSON.stringify(payload) });
    activeDraftId = draft.id;
    setDraftStatus(`Draft saved at ${new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(draft.updatedAt))}.`);
    await loadIntakeDrafts();
  } catch (error) {
    setDraftStatus(`Draft could not be saved: ${error.message}`, "error");
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshPortfolio() {
  const { projects: result } = await api("/api/v1/projects");
  projects = result;
  try {
    const { assignments } = await api("/api/v1/fellow-assignments");
    fellowAssignments = assignments;
    fellowAssignmentError = "";
  } catch (error) {
    fellowAssignments = [];
    fellowAssignmentError = error.message;
  }
  renderStats();
  renderProjects();
}

function cyclePayloadFromForm(formElement) {
  const form = new FormData(formElement);
  return {
    name: form.get("name"),
    theme: form.get("theme"),
    startsOn: form.get("startsOn"),
    endsOn: form.get("endsOn"),
    capacityUnits: Number(form.get("capacityUnits")),
    status: form.get("status"),
    steeringGroupIds: form.getAll("steeringGroupIds")
  };
}

function setCycleStatus(message = "", tone = "info") {
  const status = document.querySelector("#cycle-status");
  status.textContent = message;
  status.className = `form-status ${tone === "error" ? "is-error" : ""}`.trim();
}

function showCycleValidation(messages = []) {
  const summary = document.querySelector("#cycle-validation");
  if (!messages.length) {
    summary.hidden = true;
    summary.innerHTML = "";
    return;
  }
  summary.hidden = false;
  summary.innerHTML = `<h4>Review cycle fields</h4><ul>${messages.map(message => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`;
  summary.focus();
}

function validateCyclePayload(payload) {
  const messages = [];
  if (!String(payload.name ?? "").trim()) messages.push("Name is required.");
  if (!String(payload.theme ?? "").trim()) messages.push("Theme is required.");
  if (!payload.startsOn) messages.push("Start date is required.");
  if (!payload.endsOn) messages.push("End date is required.");
  if (payload.startsOn && payload.endsOn && new Date(`${payload.endsOn}T12:00:00`) <= new Date(`${payload.startsOn}T12:00:00`)) messages.push("End date must be after start date.");
  if (!Number.isInteger(payload.capacityUnits) || payload.capacityUnits < 1 || payload.capacityUnits > 50) messages.push("Capacity must be between 1 and 50.");
  if (!payload.steeringGroupIds.length) messages.push("Select at least one steering group member.");
  return messages;
}

function fillCycleForm(cycle = null) {
  const form = document.querySelector("#cycle-form");
  editingCycleId = cycle?.id || null;
  document.querySelector("#cycle-form-title").textContent = cycle ? "Edit cycle" : "Create a cycle";
  form.elements.name.value = cycle?.name || "";
  form.elements.theme.value = cycle?.theme || "";
  form.elements.startsOn.value = cycle?.startsOn || "";
  form.elements.endsOn.value = cycle?.endsOn || "";
  form.elements.capacityUnits.value = cycle?.capacityUnits || "";
  form.elements.status.value = cycle?.status || "planned";
  const selected = new Set(cycle?.steeringGroupIds || []);
  [...form.elements.steeringGroupIds.options].forEach(option => { option.selected = selected.has(option.value); });
  showCycleValidation([]);
  setCycleStatus(cycle ? `Editing ${cycle.name}.` : "");
}

function renderCycleAdmin() {
  const section = document.querySelector("#cycles");
  const list = document.querySelector("#cycle-list");
  if (!canAdminCycles()) {
    section.setAttribute("aria-hidden", "true");
    list.innerHTML = "";
    return;
  }
  section.removeAttribute("aria-hidden");
  list.innerHTML = cycles.length ? cycles.map(cycle => `
    <article class="cycle-item ${cycle.id === editingCycleId ? "active" : ""}">
      <div><h4>${escapeHtml(cycle.name)}</h4><p>${escapeHtml(cycle.theme)} · ${formatDate(cycle.startsOn)} to ${formatDate(cycle.endsOn)}</p></div>
      <dl><div><dt>Capacity</dt><dd>${escapeHtml(cycle.capacityUnits)}</dd></div><div><dt>Status</dt><dd>${escapeHtml(cycle.status)}</dd></div></dl>
      <button class="decision-button" type="button" data-cycle-edit="${escapeHtml(cycle.id)}">Edit</button>
    </article>`).join("") : `<p class="empty-state">No cycles configured yet.</p>`;
}

async function loadCycles() {
  if (!canAdminCycles()) {
    cycles = [];
    renderCycleAdmin();
    return;
  }
  try {
    const result = await api("/api/v1/cycles");
    cycles = result.cycles || [];
    renderCycleAdmin();
  } catch (error) {
    cycles = [];
    renderCycleAdmin();
    setCycleStatus(`Cycles could not be loaded: ${error.message}`, "error");
  }
}

async function saveCycle(event) {
  event.preventDefault();
  if (!canAdminCycles()) return setCycleStatus("You do not have permission to administer cycles.", "error");
  const payload = cyclePayloadFromForm(event.currentTarget);
  const validation = validateCyclePayload(payload);
  if (validation.length) {
    setCycleStatus("Cycle could not be saved.", "error");
    return showCycleValidation(validation);
  }
  showCycleValidation([]);
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const path = editingCycleId ? `/api/v1/cycles/${encodeURIComponent(editingCycleId)}` : "/api/v1/cycles";
    const { cycle } = await api(path, { method: editingCycleId ? "PATCH" : "POST", body: JSON.stringify(payload) });
    await loadCycles();
    fillCycleForm(cycle);
    setCycleStatus(`${cycle.name} saved.`);
    showToast("Cycle configuration saved and audited.");
  } catch (error) {
    setCycleStatus(`Cycle could not be saved: ${error.message}`, "error");
    showCycleValidation([error.message]);
  } finally {
    button.disabled = false;
  }
}

function renderStats() {
  const candidates = projects.filter(project => candidateStages.has(project.stage));
  const active = projects.filter(project => activeStages.has(project.stage));
  const acknowledged = active.filter(project => hasActiveDirectoryAssignment(project, "receivingOwner")).length;
  const potentialReach = active.reduce((total, project) => total + (Number(project.potentialReach) || 0), 0);
  document.querySelector("#active-count").textContent = String(active.length).padStart(2, "0");
  document.querySelector("#owner-count").innerHTML = `${String(acknowledged).padStart(2, "0")}<span>/${String(active.length).padStart(2, "0")}</span>`;
  document.querySelector("#reach-count").innerHTML = `${potentialReach}<span> teams</span>`;
  document.querySelector("#active-count").closest("article").querySelector(".metric-label").textContent = "Active projects";
  document.querySelector("#active-count").closest("article").querySelector(".metric-detail").textContent = `${candidates.length} candidates in triage`;
}

function renderProjects() {
  const displayed = currentFilter === "all" ? projects : projects.filter(project => project.stage === currentFilter);
  const grid = document.querySelector("#project-grid");
  grid.innerHTML = displayed.length ? displayed.map(project => {
    const gatesComplete = project.gates.filter(gate => ["complete", "excepted"].includes(gate.status)).length;
    return `<article class="project-card">
      <div class="project-top"><span class="stage ${stageClass(project.stage)}">${escapeHtml(project.stage)}</span><span class="eyebrow">${escapeHtml(project.originTeam)}</span></div>
      <h3>${escapeHtml(project.title)}</h3>
      <p class="project-description">${escapeHtml(project.problem)}</p>
      <div class="project-metric"><p class="label">Pilot metric</p><p class="result">${escapeHtml(project.metric)}</p><p class="label">Evidence status</p><p class="result">${escapeHtml(project.baseline)} → ${escapeHtml(project.target)}</p></div>
      <div class="card-foot"><span>${gatesComplete} verified gates${project.pendingDecision ? " · decision pending" : ""}</span><button class="link-button" data-project="${escapeHtml(project.id)}">Open brief →</button></div>
    </article>`;
  }).join("") : `<p class="empty-state">No projects in this stage yet.</p>`;
}

async function renderAudit() {
  const container = document.querySelector("#audit-events");
  container.innerHTML = "<p>Loading audit events…</p>";
  try {
    const { events } = await api("/api/v1/audit-events?limit=50");
    auditLoaded = true;
    container.innerHTML = events.length ? `<div class="audit-table"><div class="audit-row audit-head"><span>When</span><span>Actor</span><span>Action</span><span>Record</span></div>${events.map(event => `<div class="audit-row"><span>${escapeHtml(new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.createdAt)))}</span><span>${escapeHtml(event.actorId)}</span><span>${escapeHtml(event.action.replaceAll("_", " "))}</span><span>${escapeHtml(`${event.entityType} · ${event.entityId}`)}</span></div>`).join("")}</div>` : "<p>No audit events yet.</p>";
  } catch (error) { container.innerHTML = `<p class="audit-error">${escapeHtml(error.message)}</p>`; }
}

function openProject(id) {
  const project = getProject(id);
  if (!project) return;
  activeProjectId = id;
  const isLabLead = ["lab-lead", "admin"].includes(currentUser?.role);
  const canRequestDecision = ["Selected", "Incubating"].includes(project.stage) && !project.pendingDecision;
  const completedGates = project.gates.filter(gate => ["complete", "excepted"].includes(gate.status)).length;
  const pending = project.pendingDecision;
  const approvedRoles = new Set(pending?.approvals.filter(approval => approval.result === "approved").map(approval => approval.approverRole));
  const ownApproval = pending?.approvals.some(approval => approval.approverRole === currentUser?.role);
  const canApprove = pending && pending.requiredApprovers.includes(currentUser?.role) && pending.requestedBy !== currentUser?.id && !ownApproval;
  const missingApprovals = pending?.requiredApprovers.filter(role => !approvedRoles.has(role)) || [];
  const canFinalize = isLabLead && pending && missingApprovals.length === 0 && pending.missingGates.length === 0;
  const canAcceptHandoff = pending?.outcome === "Transfer" && currentUser?.role === "receiving-owner" && project.receivingOwner?.id === currentUser.id && hasActiveDirectoryAssignment(project, "receivingOwner") && !project.handoff;
  const canAcknowledgeAdoption = ["Submitted", "Triage"].includes(project.stage) && currentUser?.role === "receiving-owner" && project.receivingOwner?.id === currentUser.id && hasActiveDirectoryAssignment(project, "receivingOwner") && !project.adoptionAcknowledged;
  const canAddEvidence = ["Incubating", "Decision pending"].includes(project.stage) && (["lab-lead", "admin"].includes(currentUser?.role) || (currentUser?.role === "project-lead" && project.projectLead.id === currentUser.id));
  const canReview = ["Incubating", "Decision pending"].includes(project.stage) && ["platform-reviewer", "lab-lead", "admin"].includes(currentUser?.role);
  const evidenceSummary = project.evidence.length ? project.evidence.slice(0, 3).map(entry => `<li><b>${escapeHtml(entry.evidenceType.replaceAll("_", " "))}</b> · ${escapeHtml(entry.result)} <span>${escapeHtml(entry.confidence)} confidence, n=${escapeHtml(entry.sampleSize)}</span></li>`).join("") : "<li>No pilot evidence recorded yet.</li>";
  const reviewSummary = project.reviewRequirements.map(type => project.reviews.find(review => review.reviewType === type) || { reviewType: type, status: "incomplete" });
  const decisionHistory = project.decisionHistory.length ? project.decisionHistory.map(decision => `<li><b>${escapeHtml(decision.outcome)}</b> · ${escapeHtml(decision.status)} <span>${escapeHtml(decision.rationale)}</span></li>`).join("") : "<li>No decisions requested yet.</li>";
  const directoryWarnings = directoryWarningList(project);
  const integrationStatus = renderIntegrationStatus(project);
  const deliveryKitWorkspace = renderDeliveryKit(project);
  const fellowWorkspace = renderFellowAssignments(project);
  document.querySelector("#dialog-content").innerHTML = `
    <p class="eyebrow dialog-stage">${escapeHtml(project.originTeam)} · ${escapeHtml(project.stage)}</p>
    <h2 id="dialog-title" class="dialog-title">${escapeHtml(project.title)}</h2>
    <p class="dialog-problem">${escapeHtml(project.problem)}</p>
    <dl class="detail-list">
      <div><dt>Target users</dt><dd>${escapeHtml(project.users)}</dd></div>
      <div><dt>Success metric</dt><dd>${escapeHtml(project.metric)}</dd></div>
      <div><dt>Baseline → target</dt><dd>${escapeHtml(project.baseline)} → ${escapeHtml(project.target)}</dd></div>
      <div><dt>Metric source</dt><dd>${escapeHtml(project.metricSource)}</dd></div>
      <div><dt>Metric owner</dt><dd>${escapeHtml(assignmentSummary(project, "metricOwner"))}</dd></div>
      <div><dt>Potential reach</dt><dd>${escapeHtml(project.potentialReach)} teams (hypothesis)</dd></div>
      <div><dt>Sponsor</dt><dd>${escapeHtml(assignmentSummary(project, "sponsor"))}</dd></div>
      <div><dt>Receiving owner</dt><dd>${escapeHtml(assignmentSummary(project, "receivingOwner"))} · ${project.adoptionAcknowledged ? "acknowledged" : "pending acknowledgement"}</dd></div>
      <div><dt>Project lead</dt><dd>${escapeHtml(assignmentSummary(project, "projectLead"))}</dd></div>
      <div><dt>Risk classification</dt><dd>${escapeHtml(project.riskClassification)}</dd></div>
      <div><dt>Transfer target</dt><dd>${formatDate(project.transferDate)}</dd></div>
    </dl>
    ${directoryWarnings ? `<section class="directory-warnings" aria-label="Directory assignment warnings"><p class="eyebrow">Directory warnings</p><ul>${directoryWarnings}</ul></section>` : ""}
    ${integrationStatus}
    ${deliveryKitWorkspace}
    ${fellowWorkspace}
    <section class="evidence-summary"><p class="eyebrow">Pilot evidence</p><ul>${evidenceSummary}</ul></section>
    <section class="review-summary"><p class="eyebrow">Required reviews</p><ul>${reviewSummary.map(review => `<li><b>${escapeHtml(review.reviewType.replaceAll("_", " "))}</b><span class="review-${escapeHtml(review.status)}">${escapeHtml(review.status)}</span></li>`).join("")}</ul></section>
    <section class="decision-history"><p class="eyebrow">Decision history</p><ul>${decisionHistory}</ul></section>
    <div class="dialog-actions">
      <p>Verified delivery and review gates: ${completedGates}. ${pending ? `Decision request: ${escapeHtml(pending.outcome)}; approvals: ${approvedRoles.size}/${pending.requiredApprovers.length}.` : "Final decisions are disabled until independent approvals and required gates are complete."}</p>
      ${canAcknowledgeAdoption ? `<button class="decision-button" data-acknowledge-adoption>Acknowledge adoption path</button>` : ""}
      ${isLabLead && project.stage === "Triage" && project.receivingOwner && project.adoptionAcknowledged ? `<button class="decision-button" data-select-project>Approve selection</button>` : ""}
      ${isLabLead && project.stage === "Selected" ? `<button class="decision-button" data-start-incubation>Start 6–8 week incubation</button>` : ""}
      ${isLabLead && pending?.missingGates?.length ? `<div class="gate-editor"><p>Resolve a required gate with an approved evidence link.</p>${pending.missingGates.filter(key => !["metric_evidence", "receiving_owner_ack", "support_plan", "follow_up_scheduled"].includes(key)).map(key => `<label>${escapeHtml(key.replaceAll("_", " "))}<input data-gate-link="${escapeHtml(key)}" type="url" placeholder="https://intranet.example/artifact" /><button class="decision-button" data-complete-gate="${escapeHtml(key)}">Mark complete</button></label>`).join("")}</div>` : ""}
      ${canAddEvidence ? `<div class="evidence-editor"><p>Record pilot evidence</p><label>Type<select id="evidence-type"><option value="metric_result">Metric result</option><option value="user_feedback">User feedback</option><option value="pilot_demo">Pilot demo</option></select></label><label>Result<textarea id="evidence-result" placeholder="Describe the measured result or user finding."></textarea></label><label>Sample size<input id="evidence-sample" type="number" min="1" /></label><label>Confidence<select id="evidence-confidence"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label><label>Source link<input id="evidence-source" type="url" placeholder="https://intranet.example/measurement" /></label><label>Measurement date<input id="evidence-date" type="date" /></label><button class="decision-button" data-add-evidence>Record evidence</button></div>` : ""}
      ${canReview ? `<div class="review-editor"><p>Complete required review</p>${reviewSummary.filter(review => review.status === "incomplete").map(review => `<label>${escapeHtml(review.reviewType.replaceAll("_", " "))}<input data-review-link="${escapeHtml(review.reviewType)}" type="url" placeholder="https://intranet.example/review" /><button class="decision-button" data-complete-review="${escapeHtml(review.reviewType)}">Mark complete</button></label>`).join("")}</div>` : ""}
      ${canApprove ? `<div class="approval-editor"><label>Approval comment<textarea id="approval-comment" placeholder="Record the evidence and decision context."></textarea></label><div class="decision-buttons"><button class="decision-button" data-approval="approved">Approve</button><button class="decision-button" data-approval="rejected">Reject</button></div></div>` : ""}
      ${canAcceptHandoff ? `<div class="handoff-editor"><p>Receiving-owner handoff acceptance</p><label>Adoption plan link<input id="handoff-plan" type="url" placeholder="https://intranet.example/adoption-plan" /></label><label>Support end date<input id="handoff-support-end" type="date" /></label><label>30-day follow-up date<input id="handoff-follow-up" type="date" /></label><label class="check-row"><input id="handoff-onboarding" type="checkbox" /> I have completed the onboarding and accept operating ownership.</label><button class="decision-button" data-accept-handoff>Accept handoff</button></div>` : ""}
      ${canFinalize ? `<button class="decision-button finalize-button" data-finalize-decision>Finalize ${escapeHtml(pending.outcome)}</button>` : ""}
      ${canRequestDecision ? `<label class="decision-rationale">Decision rationale<textarea id="decision-rationale" placeholder="Summarize the evidence, recommended outcome, and remaining tradeoffs."></textarea></label><div class="decision-buttons"><button class="decision-button" data-decision="Scale">Request scale</button><button class="decision-button" data-decision="Transfer">Request transfer</button><button class="decision-button" data-decision="Extend once">Request extension</button><button class="decision-button" data-decision="Sunset">Request sunset</button></div>` : ""}
    </div>`;
  document.querySelector("#project-dialog").showModal();
}

async function requestDecision(outcome) {
  const rationale = document.querySelector("#decision-rationale")?.value.trim();
  if (!rationale) return showToast("Add an evidence-backed rationale before requesting a decision.");
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/decision-requests`, { method: "POST", body: JSON.stringify({ outcome, rationale }) });
    document.querySelector("#project-dialog").close();
    await refreshPortfolio();
    showToast(`${outcome} request created for independent review.`);
  } catch (error) { showToast(error.message); }
}

async function projectAction(action) {
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/${action}`, { method: "POST" });
    document.querySelector("#project-dialog").close();
    await refreshPortfolio();
    showToast(action === "select" ? "Project selected for the cycle." : "Incubation started with an auditable record.");
  } catch (error) { showToast(error.message); }
}

async function acknowledgeAdoption() {
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/adoption/acknowledge`, { method: "POST" });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Adoption path acknowledgement recorded in the audit trail.");
  } catch (error) { showToast(error.message); }
}

async function completeGate(key) {
  const evidenceLink = document.querySelector(`[data-gate-link="${CSS.escape(key)}"]`)?.value.trim();
  if (!evidenceLink) return showToast("Add an approved evidence link before completing this gate.");
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/gates/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ status: "complete", evidenceLink }) });
    await refreshPortfolio();
    openProject(activeProjectId);
    showToast("Gate completed and added to the audit trail.");
  } catch (error) { showToast(error.message); }
}

async function addEvidence() {
  const payload = {
    evidenceType: document.querySelector("#evidence-type")?.value,
    result: document.querySelector("#evidence-result")?.value.trim(),
    sampleSize: Number(document.querySelector("#evidence-sample")?.value),
    confidence: document.querySelector("#evidence-confidence")?.value,
    sourceLink: document.querySelector("#evidence-source")?.value.trim(),
    observedAt: document.querySelector("#evidence-date")?.value
  };
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/evidence`, { method: "POST", body: JSON.stringify(payload) });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Pilot evidence recorded and added to the audit trail.");
  } catch (error) { showToast(error.message); }
}

async function completeReview(reviewType) {
  const evidenceLink = document.querySelector(`[data-review-link="${CSS.escape(reviewType)}"]`)?.value.trim();
  if (!evidenceLink) return showToast("Add an approved review link before completing this review.");
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/reviews/${encodeURIComponent(reviewType)}`, { method: "PUT", body: JSON.stringify({ status: "complete", evidenceLink }) });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Required review completed and added to the audit trail.");
  } catch (error) { showToast(error.message); }
}

async function saveDeliveryKitItem(itemKey) {
  const item = document.querySelector(`[data-delivery-item="${CSS.escape(itemKey)}"]`);
  const payload = {
    status: item.querySelector("[data-delivery-status]")?.value,
    ownerId: item.querySelector("[data-delivery-owner]")?.value.trim(),
    evidenceLink: item.querySelector("[data-delivery-evidence]")?.value.trim()
  };
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/delivery-kit/${encodeURIComponent(itemKey)}`, { method: "PUT", body: JSON.stringify(payload) });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Delivery-kit item saved and audited.");
  } catch (error) { showToast(error.message); }
}

async function resetDeliveryKitItem(itemKey) {
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/delivery-kit/${encodeURIComponent(itemKey)}`, { method: "DELETE" });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Delivery-kit item reset and audited.");
  } catch (error) { showToast(error.message); }
}

async function createFellowAssignment(projectId) {
  const project = getProject(projectId);
  const payload = {
    cycleId: project.cycleId,
    projectId,
    fellowId: document.querySelector("#fellow-id")?.value.trim(),
    assignmentRole: document.querySelector("#fellow-role")?.value.trim(),
    capacityUnits: Number(document.querySelector("#fellow-capacity")?.value || 1)
  };
  try {
    await api("/api/v1/fellow-assignments", { method: "POST", body: JSON.stringify(payload) });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Fellow assignment created and awaiting manager acknowledgement.");
  } catch (error) { showToast(error.message); }
}

async function acknowledgeFellowAssignment(id) {
  try {
    await api(`/api/v1/fellow-assignments/${encodeURIComponent(id)}/manager-acknowledgement`, { method: "POST" });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Fellow assignment acknowledged and activated.");
  } catch (error) { showToast(error.message); }
}

async function respondToDecision(result) {
  const comment = document.querySelector("#approval-comment")?.value.trim();
  if (!comment) return showToast("Add an approval comment before responding.");
  try {
    await api(`/api/v1/decisions/${encodeURIComponent(getProject(activeProjectId).pendingDecision.id)}/approvals`, { method: "POST", body: JSON.stringify({ result, comment }) });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast(`Decision ${result}.`);
  } catch (error) { showToast(error.message); }
}

async function acceptHandoff() {
  const adoptionPlanLink = document.querySelector("#handoff-plan")?.value.trim();
  const supportEndDate = document.querySelector("#handoff-support-end")?.value;
  const followUpDate = document.querySelector("#handoff-follow-up")?.value;
  const onboardingAcknowledged = document.querySelector("#handoff-onboarding")?.checked;
  try {
    await api(`/api/v1/projects/${encodeURIComponent(activeProjectId)}/handoff/accept`, { method: "POST", body: JSON.stringify({ adoptionPlanLink, supportEndDate, followUpDate, onboardingAcknowledged }) });
    await refreshPortfolio(); openProject(activeProjectId);
    showToast("Handoff acceptance, support plan, and follow-up gates are recorded.");
  } catch (error) { showToast(error.message); }
}

async function finalizeDecision() {
  try {
    await api(`/api/v1/decisions/${encodeURIComponent(getProject(activeProjectId).pendingDecision.id)}/finalize`, { method: "POST" });
    document.querySelector("#project-dialog").close(); await refreshPortfolio();
    showToast("Decision finalized and written to the audit trail.");
  } catch (error) { showToast(error.message); }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 4200);
}

function showView(view) {
  if (view === "cycles" && !canAdminCycles()) {
    showToast("Cycle administration is available only to program administrators.");
    view = "overview";
  }
  document.querySelectorAll(".view").forEach(section => section.classList.toggle("active", section.id === view));
  document.querySelectorAll(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.view === view));
  const copy = { overview: ["Incubation portfolio", "Make useful things travel."], intake: ["Lab intake", "Bring a company problem."], cadence: ["Cycle 01", "Prove, transfer, repeat."], playbook: ["Operating playbook", "Create company-wide leverage."], cycles: ["Program administration", "Configure Lab cycles."], audit: ["Governance record", "See the decision trail."] }[view];
  document.querySelector("#page-kicker").textContent = copy[0];
  document.querySelector("#page-title").textContent = copy[1];
  if (view === "audit" && !auditLoaded) renderAudit();
  if (view === "cycles") loadCycles();
}

document.addEventListener("click", event => {
  const nav = event.target.closest("[data-view]");
  if (nav) { event.preventDefault(); showView(nav.dataset.view); window.location.hash = nav.dataset.view; }
  const trigger = event.target.closest("[data-open-intake]");
  if (trigger) { showView("intake"); window.location.hash = "intake"; document.querySelector("input[name=title]").focus(); }
  const filter = event.target.closest("[data-filter]");
  if (filter) { currentFilter = filter.dataset.filter; document.querySelectorAll(".filter").forEach(button => button.classList.toggle("active", button === filter)); renderProjects(); }
  const projectButton = event.target.closest("[data-project]");
  if (projectButton) openProject(projectButton.dataset.project);
  const draftButton = event.target.closest("[data-draft]");
  if (draftButton) resumeIntakeDraft(draftButton.dataset.draft);
  if (event.target.closest("[data-save-draft]")) saveIntakeDraft();
  const cycleEdit = event.target.closest("[data-cycle-edit]");
  if (cycleEdit) fillCycleForm(cycles.find(cycle => cycle.id === cycleEdit.dataset.cycleEdit));
  if (event.target.closest("[data-cycle-reset]")) fillCycleForm(null);
  const decision = event.target.closest("[data-decision]");
  if (decision) requestDecision(decision.dataset.decision);
  if (event.target.closest("[data-select-project]")) projectAction("select");
  if (event.target.closest("[data-acknowledge-adoption]")) acknowledgeAdoption();
  if (event.target.closest("[data-start-incubation]")) projectAction("start-incubation");
  const gate = event.target.closest("[data-complete-gate]");
  if (gate) completeGate(gate.dataset.completeGate);
  if (event.target.closest("[data-add-evidence]")) addEvidence();
  const review = event.target.closest("[data-complete-review]");
  if (review) completeReview(review.dataset.completeReview);
  const deliverySave = event.target.closest("[data-delivery-save]");
  if (deliverySave) saveDeliveryKitItem(deliverySave.dataset.deliverySave);
  const deliveryReset = event.target.closest("[data-delivery-reset]");
  if (deliveryReset) resetDeliveryKitItem(deliveryReset.dataset.deliveryReset);
  const fellowCreate = event.target.closest("[data-fellow-create]");
  if (fellowCreate) createFellowAssignment(fellowCreate.dataset.fellowCreate);
  const fellowAck = event.target.closest("[data-fellow-ack]");
  if (fellowAck) acknowledgeFellowAssignment(fellowAck.dataset.fellowAck);
  const approval = event.target.closest("[data-approval]");
  if (approval) respondToDecision(approval.dataset.approval);
  if (event.target.closest("[data-accept-handoff]")) acceptHandoff();
  if (event.target.closest("[data-finalize-decision]")) finalizeDecision();
  if (event.target.closest(".dialog-close")) document.querySelector("#project-dialog").close();
});

document.addEventListener("input", event => {
  if (!event.target.matches(".person-search")) return;
  window.clearTimeout(event.target._searchTimer);
  event.target._searchTimer = window.setTimeout(() => searchPeopleForField(event.target), 220);
});

document.querySelector("#demo-actor").addEventListener("change", async event => {
  demoActorId = event.currentTarget.value;
  await init();
});

document.querySelector("#intake-form").addEventListener("submit", async event => {
  event.preventDefault();
  const payload = intakePayloadFromForm(event.currentTarget);
  try {
    if (activeDraftId) {
      await api(`/api/v1/intake-drafts/${encodeURIComponent(activeDraftId)}`, { method: "PATCH", body: JSON.stringify({ content: payload }) });
      await api(`/api/v1/intake-drafts/${encodeURIComponent(activeDraftId)}/submit`, { method: "POST" });
    } else {
      await api("/api/v1/intakes", { method: "POST", body: JSON.stringify(payload) });
    }
    activeDraftId = null;
    event.currentTarget.reset();
    setDraftStatus("");
    await loadIntakeDrafts();
    await refreshPortfolio();
    showView("overview");
    window.location.hash = "overview";
    showToast("Intake submitted for triage and recorded in the audit trail.");
  } catch (error) { showToast(error.message); }
});

document.querySelector("#cycle-form").addEventListener("submit", saveCycle);

async function init() {
  try {
    const session = await api("/api/v1/session");
    demoMode = session.demoMode;
    const { user } = session;
    currentUser = user;
    document.querySelector("#identity-note").textContent = `${demoMode ? "Demo" : "Signed in"}: ${user.name} · ${user.role}`;
    document.querySelector("#demo-actor-wrap").hidden = !demoMode;
    document.querySelector("#demo-actor").value = demoActorId;
    document.querySelector("#audit-nav").hidden = !["lab-lead", "executive-sponsor", "admin"].includes(user.role);
    document.querySelector("#cycle-admin-nav").hidden = !canAdminCycles();
    await refreshPortfolio();
    await loadIntakeDrafts();
    await loadCycles();
  } catch (error) {
    document.querySelector("#identity-note").textContent = "Sign-in required";
    intakeDrafts = [];
    renderIntakeDrafts();
    showToast(error.message);
  }
}

const initialView = window.location.hash.slice(1);
if (["overview", "intake", "cadence", "playbook", "cycles"].includes(initialView)) showView(initialView);
init();
