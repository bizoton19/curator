import type { Workspace } from "../core";

export type EstimateScenarioId = "lean" | "expected" | "conservative";

export type EstimateDriver = {
  id: string;
  label: string;
  score: number;
  impact: "high" | "medium" | "low";
  category: string;
  description: string;
  sources: string[];
  rangeImpact: string;
};

export type EstimateScenario = {
  id: EstimateScenarioId;
  label: string;
  low: number;
  high: number;
  confidence: number;
  narrative: string;
};

export type EstimateQuestion = {
  id: string;
  question: string;
  reason: string;
  target: "baseline" | "requirements" | "tasks" | "context";
};

export type TraceabilityItem = {
  label: string;
  detail: string;
  source: string;
};

export type EstimateCopilotModel = {
  headline: string;
  executiveSummary: string;
  costLow: number;
  costHigh: number;
  confidence: number;
  confidenceLabel: string;
  assumptions: string[];
  unknowns: string[];
  drivers: EstimateDriver[];
  savings: EstimateDriver[];
  scenarios: Record<EstimateScenarioId, EstimateScenario>;
  nextQuestions: EstimateQuestion[];
  traceability: TraceabilityItem[];
  sourceCoverage: {
    baseline: number;
    requirements: number;
    tasks: number;
    context: number;
  };
};

const DRIVER_RULES = [
  {
    id: "labor",
    label: "Labor shape",
    category: "Labor",
    patterns: [
      "team",
      "engineer",
      "developer",
      "architect",
      "analyst",
      "consultant",
      "project manager",
      "qa",
      "sme"
    ],
    description: "Staffing mix and role depth will materially affect delivery cost.",
    rangeImpact: "Higher specialist coverage increases rate pressure and review time."
  },
  {
    id: "integration",
    label: "Integration surface",
    category: "Delivery",
    patterns: [
      "integration",
      "api",
      "erp",
      "crm",
      "system",
      "connector",
      "migration",
      "interface"
    ],
    description: "Integration breadth expands delivery dependencies and testing effort.",
    rangeImpact: "Each upstream or downstream dependency widens delivery variability."
  },
  {
    id: "data",
    label: "Data and reporting",
    category: "Data volume",
    patterns: [
      "data",
      "etl",
      "pipeline",
      "lake",
      "warehouse",
      "fabric",
      "dashboard",
      "reporting",
      "analytics"
    ],
    description: "Data preparation and reporting often add hidden effort beyond core build scope.",
    rangeImpact: "Poorly defined data quality or reporting requirements widen the estimate."
  },
  {
    id: "ai",
    label: "AI and model complexity",
    category: "Engineering",
    patterns: [
      "ai",
      "ml",
      "model",
      "training",
      "inference",
      "classification",
      "prediction",
      "vision",
      "llm"
    ],
    description: "Model build, validation, and iteration increase execution uncertainty.",
    rangeImpact: "AI-driven delivery tends to widen the conservative scenario the most."
  },
  {
    id: "compliance",
    label: "Compliance and control",
    category: "Governance",
    patterns: [
      "privacy",
      "security",
      "audit",
      "compliance",
      "governance",
      "pii",
      "sox",
      "hipaa",
      "risk"
    ],
    description: "Control requirements add review cycles, design constraints, and acceptance overhead.",
    rangeImpact: "Compliance-heavy scopes drive more review effort and downstream change control."
  },
  {
    id: "operations",
    label: "Support and operations",
    category: "Operations",
    patterns: [
      "support",
      "maintenance",
      "monitoring",
      "runbook",
      "sla",
      "operations",
      "rollout",
      "adoption"
    ],
    description: "Operational readiness often separates a draft estimate from a finance-ready estimate.",
    rangeImpact: "Support expectations create recurring cost and increase total cost of ownership."
  }
] as const;

const SAVINGS_RULES = [
  {
    id: "reuse",
    label: "Reuse existing assets",
    category: "Labor",
    patterns: ["reuse", "existing", "current", "already", "as-is", "leverage"],
    description: "Leveraging existing platforms reduces new build effort and validation cycles.",
    rangeImpact: "Higher reuse pushes the range lower without reducing confidence."
  },
  {
    id: "automation",
    label: "Automation and self-service",
    category: "Labor",
    patterns: ["automation", "self-service", "template", "workflow", "script", "ci/cd"],
    description: "Automated delivery steps compress effort and reduce manual handoffs.",
    rangeImpact: "Automation narrows the delivery window and reduces variance."
  },
  {
    id: "cloud",
    label: "Cloud optimization",
    category: "Infrastructure",
    patterns: ["reserved instance", "savings plan", "credits", "optimization", "autoscaling", "serverless", "right-size"],
    description: "Optimization levers lower infrastructure run-rate and operational overhead.",
    rangeImpact: "Well-defined optimization levers reduce infra-heavy scenario highs."
  },
  {
    id: "managed",
    label: "Managed services",
    category: "Operations",
    patterns: ["managed service", "saas", "vendor", "platform", "outsource", "partner"],
    description: "Managed platforms reduce ongoing maintenance and support burden.",
    rangeImpact: "Service consolidation lowers operational cost exposure."
  },
  {
    id: "phased",
    label: "Phased delivery",
    category: "Risk",
    patterns: ["phase", "pilot", "mvp", "incremental", "rollout", "staged"],
    description: "Phased rollout limits upfront effort and reduces risk-driven padding.",
    rangeImpact: "Phasing improves confidence on the initial scenario band."
  },
  {
    id: "standardize",
    label: "Standardization and templates",
    category: "Process",
    patterns: ["standard", "template", "playbook", "reference architecture", "repeatable"],
    description: "Using proven patterns speeds delivery and reduces rework.",
    rangeImpact: "Repeatable delivery lowers both labor and QA effort."
  }
] as const;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(text: string, term: string) {
  const matches = text.toLowerCase().match(new RegExp(escapeRegExp(term), "g"));
  return matches ? matches.length : 0;
}

function coverageScore(text: string, target: number) {
  return Math.max(8, Math.min(100, Math.round((text.trim().length / target) * 100)));
}

function extractBulletLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function pickAssumptions(baseline: string, requirements: string) {
  const bullets = [
    ...extractBulletLines(baseline),
    ...extractBulletLines(requirements)
  ];
  return bullets
    .filter((line) =>
      /assum|budget|timeline|rate|team|scope|client|data|support/i.test(line)
    )
    .slice(0, 4);
}

function hasSignal(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function buildUnknowns(
  baseline: string,
  requirements: string,
  tasks: string,
  workspace: Workspace | null
) {
  const unknowns: string[] = [];
  const combined = `${baseline}\n${requirements}\n${tasks}`.toLowerCase();

  if (!hasSignal(combined, ["budget", "cost", "funding", "rate"])) {
    unknowns.push("No explicit budget guardrail or commercial range is defined yet.");
  }
  if (!hasSignal(combined, ["timeline", "deadline", "quarter", "week", "month"])) {
    unknowns.push("Timeline pressure is unclear, so schedule compression risk is not priced in.");
  }
  if (!hasSignal(combined, ["team", "role", "architect", "engineer", "analyst", "pm"])) {
    unknowns.push("The target delivery team shape is missing, so labor assumptions remain soft.");
  }
  if ((workspace?.contextDocuments.length ?? 0) === 0) {
    unknowns.push("No supporting context documents are attached, limiting defensibility for finance review.");
  }
  if (extractBulletLines(tasks).length < 4) {
    unknowns.push("Execution tasks are still thin, which weakens bottom-up effort confidence.");
  }

  return unknowns.slice(0, 4);
}

function buildFactorSignals(
  rules: typeof DRIVER_RULES | typeof SAVINGS_RULES,
  sections: ReadonlyArray<{ label: string; text: string }>,
  contextCount: number
) {
  return rules
    .map((rule) => {
      const sources: string[] = [];
      let score = 0;

      for (const section of sections) {
        const sectionScore = rule.patterns.reduce(
          (sum, term) => sum + countOccurrences(section.text, term),
          0
        );
        if (sectionScore > 0) {
          sources.push(section.label);
          score += sectionScore;
        }
      }

      if (contextCount > 0) {
        score += 1;
        if (!sources.includes("Context docs")) sources.push("Context docs");
      }

      return {
        id: rule.id,
        label: rule.label,
        score,
        impact: score >= 6 ? "high" : score >= 3 ? "medium" : "low",
        category: rule.category,
        description: rule.description,
        sources,
        rangeImpact: rule.rangeImpact
      } as EstimateDriver;
    })
    .filter((driver) => driver.score > 0)
    .sort((a, b) => b.score - a.score);
}

function confidenceLabel(confidence: number) {
  if (confidence >= 78) return "High confidence";
  if (confidence >= 60) return "Moderate confidence";
  return "Low confidence";
}

function scenarioNarrative(id: EstimateScenarioId, drivers: EstimateDriver[]) {
  const top = drivers[0]?.label ?? "delivery scope";
  if (id === "lean") {
    return `Assumes controlled scope and limited rework around ${top.toLowerCase()}.`;
  }
  if (id === "conservative") {
    return `Assumes broader review cycles and higher variance around ${top.toLowerCase()}.`;
  }
  return "Balances expected delivery effort against the current level of scope definition.";
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

export function summarizeDiff(originalContent: string, newContent: string) {
  const before = originalContent.split(/\r?\n/);
  const after = newContent.split(/\r?\n/);
  let added = 0;
  let removed = 0;
  const highlights: string[] = [];
  const maxLength = Math.max(before.length, after.length);

  for (let i = 0; i < maxLength; i += 1) {
    const previous = before[i] ?? "";
    const next = after[i] ?? "";
    if (previous === next) continue;

    if (previous && !next) removed += 1;
    else if (!previous && next) added += 1;
    else {
      added += 1;
      removed += 1;
    }

    if (highlights.length < 3) {
      highlights.push(next || previous);
    }
  }

  return { added, removed, highlights };
}

export function buildEstimateCopilotModel(args: {
  workspace: Workspace | null;
  baseline: string;
  requirements: string;
  tasks: string;
}): EstimateCopilotModel {
  const { workspace, baseline, requirements, tasks } = args;
  const sections = [
    { label: "Baseline", text: baseline },
    { label: "Requirements", text: requirements },
    { label: "Tasks", text: tasks }
  ] as const;

  const combined = sections.map((section) => section.text).join("\n\n");
  const taskCount = extractBulletLines(tasks).length;
  const contextCount = workspace?.contextDocuments.length ?? 0;
  const markdownCount = workspace?.markdownFiles.length ?? 0;

  const drivers = buildFactorSignals(DRIVER_RULES, sections, contextCount).slice(0, 4);
  const savings = buildFactorSignals(SAVINGS_RULES, sections, contextCount).slice(0, 4);

  const complexityScore =
    drivers.reduce((sum, driver) => sum + driver.score, 0) +
    Math.max(taskCount - 3, 0) +
    contextCount * 2 +
    markdownCount;

  const expectedLow = Math.max(65000, 90000 + complexityScore * 18000);
  const expectedHigh = Math.round(expectedLow * 1.42);
  const unknowns = buildUnknowns(baseline, requirements, tasks, workspace);
  const assumptions = pickAssumptions(baseline, requirements);

  const confidence = Math.max(
    38,
    Math.min(
      91,
      76 +
        Math.round(
          (coverageScore(baseline, 650) +
            coverageScore(requirements, 900) +
            coverageScore(tasks, 500)) / 18
        ) +
        Math.min(contextCount * 3, 9) -
        unknowns.length * 7
    )
  );

  const scenarios: Record<EstimateScenarioId, EstimateScenario> = {
    lean: {
      id: "lean",
      label: "Lean",
      low: Math.round(expectedLow * 0.82),
      high: Math.round(expectedHigh * 0.88),
      confidence: Math.max(confidence - 8, 30),
      narrative: scenarioNarrative("lean", drivers)
    },
    expected: {
      id: "expected",
      label: "Expected",
      low: expectedLow,
      high: expectedHigh,
      confidence,
      narrative: scenarioNarrative("expected", drivers)
    },
    conservative: {
      id: "conservative",
      label: "Conservative",
      low: Math.round(expectedLow * 1.14),
      high: Math.round(expectedHigh * 1.32),
      confidence: Math.min(confidence + 4, 95),
      narrative: scenarioNarrative("conservative", drivers)
    }
  };

  const nextQuestions: EstimateQuestion[] = [];
  if (!hasSignal(combined.toLowerCase(), ["budget", "cost", "funding", "rate"])) {
    nextQuestions.push({
      id: "budget-guardrail",
      question: "What budget guardrail or commercial target range should anchor the estimate?",
      reason: "Finance buyers need a range anchor before evaluating scenarios.",
      target: "requirements"
    });
  }
  if (!hasSignal(combined.toLowerCase(), ["timeline", "deadline", "milestone", "week", "month", "quarter"])) {
    nextQuestions.push({
      id: "timeline-pressure",
      question: "What delivery deadline or milestone date constrains the estimate?",
      reason: "Schedule pressure changes staffing shape and risk loading.",
      target: "requirements"
    });
  }
  if (!hasSignal(combined.toLowerCase(), ["team", "architect", "engineer", "analyst", "pm", "qa"])) {
    nextQuestions.push({
      id: "team-shape",
      question: "Which delivery roles are assumed to be client-side versus vendor-side?",
      reason: "Role split changes labor mix and margin assumptions.",
      target: "baseline"
    });
  }
  if (contextCount === 0) {
    nextQuestions.push({
      id: "context-pack",
      question: "Which prior estimates, rate cards, or architecture docs should be attached as context?",
      reason: "Supporting evidence increases estimate defensibility in review.",
      target: "context"
    });
  }
  if (taskCount < 4) {
    nextQuestions.push({
      id: "task-breakdown",
      question: "Which workstreams should be broken into explicit plan, execute, review, and refine tasks?",
      reason: "A bottom-up task view improves effort transparency.",
      target: "tasks"
    });
  }

  const traceability: TraceabilityItem[] = [
    {
      label: "Baseline coverage",
      detail: `${coverageScore(baseline, 650)}% complete based on current narrative and bullets.`,
      source: "baseline.md"
    },
    {
      label: "Requirements signal",
      detail: `${coverageScore(requirements, 900)}% complete with ${extractBulletLines(requirements).length} structured bullets detected.`,
      source: "requirements.md"
    },
    {
      label: "Task readiness",
      detail: `${taskCount} execution bullets are available for bottom-up review.`,
      source: "tasks.md"
    },
    {
      label: "Context grounding",
      detail: `${contextCount} context document(s) and ${markdownCount} supplemental markdown file(s) are available.`,
      source: "workspace"
    }
  ];

  for (const driver of drivers.slice(0, 3)) {
    traceability.push({
      label: driver.label,
      detail: `${driver.description} Sources: ${driver.sources.join(", ")}.`,
      source: driver.sources.join(", ")
    });
  }

  const headline = drivers.length
    ? `${drivers[0].label} is currently the strongest driver of estimate variability.`
    : "Scope definition is still too light for a strong estimate signal.";

  const executiveSummary =
    unknowns.length === 0
      ? `Current inputs support a defensible working range of ${formatCurrency(expectedLow)} to ${formatCurrency(expectedHigh)} with ${confidenceLabel(confidence).toLowerCase()}.`
      : `Current inputs support an early working range of ${formatCurrency(expectedLow)} to ${formatCurrency(expectedHigh)}, but key unknowns are still widening the estimate.`;

  return {
    headline,
    executiveSummary,
    costLow: expectedLow,
    costHigh: expectedHigh,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    assumptions,
    unknowns,
    drivers,
    savings,
    scenarios,
    nextQuestions: nextQuestions.slice(0, 4),
    traceability,
    sourceCoverage: {
      baseline: coverageScore(baseline, 650),
      requirements: coverageScore(requirements, 900),
      tasks: coverageScore(tasks, 500),
      context: contextCount === 0 ? 10 : Math.min(100, 30 + contextCount * 18)
    }
  };
}

export function buildCostEstimateMarkdown(
  model: EstimateCopilotModel,
  scenario: EstimateScenario
) {
  const drivers = model.drivers.length
    ? model.drivers.map((driver) => `- ${driver.label}: ${driver.description}`).join("\n")
    : "- Add more project detail to surface drivers.";
  const savings = model.savings.length
    ? model.savings.map((item) => `- ${item.label}: ${item.description}`).join("\n")
    : "- Add known savings levers (reuse, managed services, or optimization) to surface this section.";
  const assumptions = model.assumptions.length
    ? model.assumptions.map((item) => `- ${item}`).join("\n")
    : "- Capture delivery assumptions in baseline.md to strengthen this section.";
  const unknowns = model.unknowns.length
    ? model.unknowns.map((item) => `- ${item}`).join("\n")
    : "- No major unknowns detected in the current workspace context.";
  const nextQuestions = model.nextQuestions.length
    ? model.nextQuestions.map((item) => `- ${item.question}`).join("\n")
    : "- No follow-up questions detected.";

  return `# Cost Estimate

## Executive Summary
${model.executiveSummary}

## Recommended Scenario
- Scenario: ${scenario.label}
- Range: ${formatCurrency(scenario.low)} to ${formatCurrency(scenario.high)}
- Confidence: ${model.confidenceLabel} (${scenario.confidence}%)

## Top Cost Drivers
${drivers}

## Cost Savings Levers
${savings}

## Assumptions
${assumptions}

## Unknowns and Risks
${unknowns}

## Next Questions
${nextQuestions}
`;
}
