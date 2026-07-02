import { stages } from "./workflow-policy.mjs";

const candidateStages = new Set([stages.SUBMITTED, stages.TRIAGE]);
const activeStages = new Set([stages.SELECTED, stages.INCUBATING]);
const finalAdopterStages = new Set([stages.TRANSFERRED, stages.OPERATING]);

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueSorted(values) {
  return [...new Set(values.map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function projectOutcome(project) {
  return project.pendingDecision?.outcome || project.decisionHistory?.find(decision => decision.status === "finalized")?.outcome || "";
}

function projectOwnerIds(project) {
  return uniqueSorted([
    project.createdBy,
    project.metricOwnerId,
    project.sponsor?.id,
    project.receivingOwner?.id,
    project.projectLead?.id
  ]);
}

function sourceHref(sourceRef) {
  return /^https:\/\/[^ "]+$/i.test(sourceRef) ? sourceRef : null;
}

function metricSource(project) {
  const plan = project.metricPlan;
  if (plan) {
    const verified = plan.refreshStatus === "verified";
    return {
      projectId: project.id,
      title: project.title,
      status: plan.refreshStatus,
      label: verified ? plan.verifiedValue : plan.hypothesisLabel,
      sourceLabel: plan.sourceRef,
      sourceHref: sourceHref(plan.sourceRef),
      verifiedAt: plan.verifiedAt,
      staleAt: plan.staleAt
    };
  }
  return {
    projectId: project.id,
    title: project.title,
    status: "hypothesis",
    label: `${project.baseline} -> ${project.target}`,
    sourceLabel: project.metricSource || "Unverified hypothesis",
    sourceHref: null,
    verifiedAt: null,
    staleAt: null
  };
}

function atRisk(project) {
  return Boolean(
    project.metricPlan?.refreshStatus === "stale"
    || project.followUp?.derivedStatus === "overdue"
    || project.directoryWarnings?.length
    || project.pendingDecision?.missingGates?.length
  );
}

export function normalizePortfolioFilters(input = {}) {
  return {
    cycleId: clean(input.cycleId),
    stage: clean(input.stage),
    ownerId: clean(input.ownerId),
    risk: clean(input.risk),
    outcome: clean(input.outcome),
    theme: clean(input.theme)
  };
}

export function buildPortfolioMetrics({ projects = [], cycles = [], filters = {} } = {}) {
  const normalized = normalizePortfolioFilters(filters);
  const cycleById = new Map(cycles.map(cycle => [cycle.id, cycle]));
  const filteredProjects = projects.filter(project => {
    const cycle = cycleById.get(project.cycleId);
    if (normalized.cycleId && project.cycleId !== normalized.cycleId) return false;
    if (normalized.stage && project.stage !== normalized.stage) return false;
    if (normalized.ownerId && !projectOwnerIds(project).includes(normalized.ownerId)) return false;
    if (normalized.risk && project.riskClassification !== normalized.risk) return false;
    if (normalized.outcome && projectOutcome(project) !== normalized.outcome) return false;
    if (normalized.theme && !clean(cycle?.theme).toLowerCase().includes(normalized.theme.toLowerCase())) return false;
    return true;
  });

  return {
    filters: normalized,
    counts: {
      candidate: filteredProjects.filter(project => candidateStages.has(project.stage)).length,
      active: filteredProjects.filter(project => activeStages.has(project.stage)).length,
      decisionPending: filteredProjects.filter(project => project.stage === stages.DECISION_PENDING || project.pendingDecision).length,
      validatedAdopter: filteredProjects.filter(project => finalAdopterStages.has(project.stage) || project.handoff).length,
      validatedImpact: filteredProjects.filter(project => project.metricPlan?.refreshStatus === "verified").length,
      atRisk: filteredProjects.filter(atRisk).length
    },
    impact: {
      potentialReach: filteredProjects.reduce((total, project) => total + (Number(project.potentialReach) || 0), 0),
      validatedReach: filteredProjects.filter(project => project.metricPlan?.refreshStatus === "verified").reduce((total, project) => total + (Number(project.potentialReach) || 0), 0)
    },
    metricSources: filteredProjects.map(metricSource),
    projects: filteredProjects.map(project => ({
      id: project.id,
      title: project.title,
      stage: project.stage,
      cycleId: project.cycleId,
      riskClassification: project.riskClassification,
      outcome: projectOutcome(project) || null
    })),
    availableFilters: {
      cycles: cycles.map(cycle => ({ id: cycle.id, name: cycle.name, theme: cycle.theme })),
      stages: uniqueSorted(projects.map(project => project.stage)),
      owners: uniqueSorted(projects.flatMap(projectOwnerIds)),
      risks: uniqueSorted(projects.map(project => project.riskClassification)),
      outcomes: uniqueSorted(projects.map(projectOutcome)),
      themes: uniqueSorted(cycles.map(cycle => cycle.theme))
    }
  };
}
