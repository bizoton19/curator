import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  PermissionGate,
  WORKSPACE_FILE_ORDER,
  Workspace,
  WorkspaceFileId,
  WorkspaceManager,
  WorkspaceSupplementalFile,
  SearchResult
} from "../core";
import { EditorController } from "../core/wysiwyg/EditorController";
import { MarkdownEditor } from "./editor/MarkdownEditor";
import { PlainTextEditor } from "./editor/PlainTextEditor";
import { LiveSyncIndicator } from "./components/LiveSyncIndicator";
import {
  buildCostEstimateMarkdown,
  buildEstimateCopilotModel,
  formatCurrency,
  summarizeDiff,
  type EstimateScenarioId
} from "./copilot";
import helpKbRaw from "./kb/help.md?raw";

type OpenResult = Workspace | null;
type PermissionResult = boolean;
type WorkspaceSummary = { id: string; name: string; path: string };
type ActiveEditor =
  | { kind: "core"; id: WorkspaceFileId }
  | {
      kind: "supplemental";
      file: WorkspaceSupplementalFile;
      isMarkdown: boolean;
    };

type PendingEdit = {
  id: string;
  fileId: string;
  kind: "core" | "supplemental" | "newSupplemental";
  originalContent: string;
  newContent: string;
  label: string;
};

const MAX_CONTEXT_DOCUMENTS = 10;
const MAX_CHAT_CONTEXT_CHARS = 2400;

const BASELINE_TEMPLATE =
  "# Baseline\n\n## Project Overview\n\n## Scope\n\n## Assumptions\n\n";
const TASKS_TEMPLATE =
  "# Tasks\n\n## PLAN\n- \n\n## EXECUTE\n- \n\n## REVIEW\n- \n\n## REFINE\n- \n";
const BASELINE_EXAMPLE = `# Baseline

## Project Overview
Short description of the engagement.

## Scope
- Included systems and modules
- Out-of-scope items

## Assumptions
- Access to SMEs
- Existing data availability`;

const REQUIREMENTS_EXAMPLE = `# Requirements

## Goals
- Define the cost estimation deliverable
- Confirm systems in scope

## Success Criteria
- Estimate is defensible and documented
- Risks and assumptions are explicit

## Constraints
- Timeline
- Budget guardrails`;

/** Format for AI to request file edits: JSON in a code block with language curator_edits */
const CURATOR_EDITS_BLOCK_REGEX = /```curator_edits\s*\n([\s\S]*?)\n```/;
type CuratorEdit = { file: string; content: string };
type CuratorEditsPayload = { edits: CuratorEdit[] };
type HelpSection = { title: string; body: string; keywords: string[] };
type InsightItem = {
  label: string;
  category: string;
  impact: "high" | "medium" | "low";
  description: string;
  sources?: string[];
};
type InsightPayload = {
  summary: string;
  rangeLow: number;
  rangeHigh: number;
  confidence: number;
  confidenceLabel: string;
  scenarioLabel: string;
  scenarioNarrative: string;
  drivers: InsightItem[];
  savings: InsightItem[];
};
type CuratorInsightsPayload = {
  costEstimateMarkdown: string;
  insights: InsightPayload;
};
type InsightGroup = { category: string; items: InsightItem[] };

function parseCuratorEdits(message: string): CuratorEditsPayload | null {
  const match = message.match(CURATOR_EDITS_BLOCK_REGEX);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim()) as CuratorEditsPayload;
    if (!Array.isArray(parsed?.edits)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stripCuratorEditsBlock(message: string): string {
  return message.replace(CURATOR_EDITS_BLOCK_REGEX, "").trim();
}

const CURATOR_INSIGHTS_BLOCK_REGEX = /```curator_insights\s*\n([\s\S]*?)\n```/;

function parseCuratorInsights(message: string): CuratorInsightsPayload | null {
  const match = message.match(CURATOR_INSIGHTS_BLOCK_REGEX);
  const raw = match ? match[1].trim() : message.trim();
  if (!raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as CuratorInsightsPayload;
    if (!parsed?.costEstimateMarkdown || !parsed?.insights) return null;
    return parsed;
  } catch {
    return null;
  }
}

function basenameLike(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function normalizeRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripExtensionLike(filename: string): string {
  const index = filename.lastIndexOf(".");
  return index > 0 ? filename.slice(0, index) : filename;
}

function parseHelpSections(raw: string): HelpSection[] {
  const blocks = raw.split(/\n##\s+/).map((block) => block.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const title = lines[0]?.replace(/^#+\s*/, "").trim() || "Help";
    const body = lines.slice(1).join("\n").trim();
    const keywordSeed = `${title} ${body}`.toLowerCase();
    const keywords = Array.from(
      new Set(
        keywordSeed
          .replace(/[^a-z0-9\s-]/g, " ")
          .split(/\s+/)
          .filter((token) => token.length > 2)
      )
    );
    return { title, body, keywords };
  });
}

function getHelpResponse(
  message: string,
  sections: HelpSection[]
): { title: string; body: string } | null {
  const query = message.trim().toLowerCase();
  if (!query) return null;
  const trigger =
    /(how do i|how to|what is|where is|explain|help|meaning)/.test(query) ||
    /(baseline|requirements|tasks|context|template|export|workspace|search|chat|settings|api key)/.test(query);
  if (!trigger) return null;
  let best: { score: number; section: HelpSection } | null = null;
  for (const section of sections) {
    let score = 0;
    if (query.includes(section.title.toLowerCase())) score += 4;
    for (const keyword of section.keywords) {
      if (query.includes(keyword)) score += 1;
    }
    if (!best || score > best.score) {
      best = { score, section };
    }
  }
  if (!best || best.score === 0) return null;
  return { title: best.section.title, body: best.section.body };
}

function renderSnippet(snippet: string) {
  if (!snippet) return null;
  const parts = snippet.split(/\[(.*?)\]/g);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
}

function groupInsights(items: InsightItem[]): InsightGroup[] {
  const groups = new Map<string, InsightItem[]>();
  for (const item of items) {
    const key = item.category || "General";
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }
  return Array.from(groups.entries()).map(([category, groupItems]) => ({
    category,
    items: groupItems
  }));
}

function resolveWorkspaceEditTarget(
  workspace: Workspace,
  rawFileRef: string
):
  | { kind: "core"; id: WorkspaceFileId; label: string }
  | { kind: "supplemental"; path: string; label: string }
  | { kind: "newSupplemental"; name: string; label: string }
  | null {
  const ref = rawFileRef.trim();
  if (!ref) return null;

  const coreById = new Set<WorkspaceFileId>(["baseline", "requirements", "tasks"]);
  if (coreById.has(ref as WorkspaceFileId)) {
    return { kind: "core", id: ref as WorkspaceFileId, label: ref };
  }
  const refAsCoreFilename = ref.toLowerCase().replace(/\.md$/, "");
  if (coreById.has(refAsCoreFilename as WorkspaceFileId)) {
    return {
      kind: "core",
      id: refAsCoreFilename as WorkspaceFileId,
      label: refAsCoreFilename
    };
  }

  const candidates = [
    ...workspace.markdownFiles,
    ...workspace.contextDocuments
  ];
  const normRef = normalizeRef(ref);
  for (const file of candidates) {
    const byPath = file.path === ref;
    const byName = file.name.toLowerCase() === ref.toLowerCase();
    const byBasePath = basenameLike(file.path).toLowerCase() === ref.toLowerCase();
    const byNormalizedName = normalizeRef(file.name) === normRef;
    const byNormalizedStem =
      normalizeRef(stripExtensionLike(file.name)) === normRef;
    if (byPath || byName || byBasePath || byNormalizedName || byNormalizedStem) {
      return { kind: "supplemental", path: file.path, label: file.name };
    }
  }

  // Allow new supplemental file creation by filename (e.g., "risk-notes.md")
  if (/\.[a-z0-9]+$/i.test(ref) && !ref.includes("/") && !ref.includes("\\")) {
    return { kind: "newSupplemental", name: ref, label: ref };
  }
  return null;
}

const TASKS_EXAMPLE = `# Tasks

## PLAN
- Review baseline.md and requirements.md
- Identify missing context documents

## EXECUTE
- Analyze context documents in context-documents/
- Create estimate table using template

## REVIEW
- Summarize cost drivers
- Highlight risks and assumptions

## REFINE
- Update tasks based on review feedback`;

// Training Module: AI-Powered Product Sample Labeling System scenario
const TRAINING_BASELINE = `# Baseline

## Project Overview
Enterprise AI/ML solution for automated product sample labeling and classification. The system will process images from three input channels (industrial scanners, Meta smart glasses, iPhone cameras) and apply trained ML models to automatically categorize and label product samples in real-time.

## Scope

### In Scope
- Azure cloud infrastructure design and deployment
- ML model development for product classification (transfer learning approach)
- Integration with existing scanner hardware via REST APIs
- Meta Quest/smart glasses companion app for hands-free capture
- iOS mobile app for iPhone camera integration
- Real-time inference pipeline using Azure ML
- Integration with Microsoft Fabric for data lakehouse storage
- PySpark ETL pipelines for training data preparation
- Dashboard for QC managers (Power BI embedded)
- 5-year total cost of ownership model

### Out of Scope
- Hardware procurement (scanners, glasses, phones)
- On-premise server infrastructure
- ERP integration (phase 2)
- Multi-language label support (English only for v1)

## Assumptions
- Client has existing Azure subscription with Foundry access
- Network connectivity at all capture stations (WiFi 6 minimum)
- Product catalog with 500-2000 SKU categories for initial training
- Client will provide 10,000+ labeled sample images for model training
- Privacy requirements allow cloud processing (no on-premise mandate)
- DC labor rates apply (Washington DC metro area contractors)
- 5-year planning horizon for cost estimates
- Client IT team available for knowledge transfer

## Constraints
- Budget approval required before Phase 2
- Go-live target: Q3 2026
- Must comply with client's existing Azure governance policies
- Model accuracy target: 95%+ on known SKUs`;

const TRAINING_REQUIREMENTS = `# Requirements

## Goals
- Reduce manual labeling time by 80% within 6 months of deployment
- Achieve 95%+ classification accuracy on trained product categories
- Support real-time inference (<2 second response time per image)
- Enable hands-free operation for floor inspectors via smart glasses

## Constraints
- Timeline: 9-month delivery schedule (3 phases)
- Budget: Initial estimate range $800K-$1.2M over 5 years
- Team: Blended team (client + contractor) with DC labor rates
- Technology: Must use Azure services (Foundry, Fabric, Azure ML)

## Acceptance Criteria
- ML model passes UAT with 95%+ accuracy on test dataset
- All three input channels (scanner, glasses, iPhone) functional
- Real-time dashboard shows labeling metrics and confidence scores
- Cost estimate is auditable with line-item breakdown
- 5-year TCO model approved by client finance

## Pricing Inputs
- Labor: DC metro rates ($150-250/hr depending on role)
- Azure consumption: Estimated $15-25K/month at steady state
- ML training compute: One-time $10-20K for initial model development
- Licensing: Microsoft Fabric, Power BI Pro seats
- Support: 20% annual maintenance after go-live`;

const TRAINING_TASKS = `# Tasks

## PLAN
- Review baseline.md to confirm scope boundaries and assumptions
- Review requirements.md to understand success criteria and constraints
- Analyze context documents in context-documents/ for technical specifications
- Identify any gaps in provided information that need client clarification

## EXECUTE
- Create work breakdown structure with 3 phases (Foundation, Core ML, Integration)
- Estimate labor hours by role (Architect, ML Engineer, Mobile Dev, DevOps)
- Apply DC labor rates to hour estimates
- Calculate Azure infrastructure costs using Azure pricing calculator assumptions
- Build 5-year cost projection including maintenance and scaling
- Generate cost-estimate.md with summary table and detailed breakdown

## REVIEW
- Validate estimates against similar projects in templates/
- Summarize key cost drivers and risk factors
- Highlight assumptions that most impact the estimate
- Flag any scope items that need clarification before finalizing

## REFINE
- Update estimates based on review feedback
- Add contingency recommendations (typically 15-25% for ML projects)
- Prepare executive summary for client presentation`;

const TRAINING_CONTEXT_AZURE = `# Azure Architecture Overview

## Compute
- Azure Machine Learning workspace for model training and deployment
- Azure Kubernetes Service (AKS) for inference endpoints
- Azure Functions for event-driven image processing

## Storage
- Microsoft Fabric Lakehouse for raw and processed images
- Azure Blob Storage for model artifacts
- Azure SQL for metadata and labeling results

## Integration
- Azure Event Grid for real-time event routing
- Azure API Management for external API exposure
- Azure IoT Hub for scanner device management`;

const TRAINING_CONTEXT_LABOR = `# DC Metro Labor Rate Card

| Role | Hourly Rate | Notes |
|------|-------------|-------|
| Solution Architect | $225/hr | Azure certified |
| ML Engineer | $200/hr | Python, PySpark, Azure ML |
| Mobile Developer | $175/hr | iOS + React Native |
| DevOps Engineer | $185/hr | Azure DevOps, Terraform |
| QA Engineer | $150/hr | Test automation |
| Project Manager | $165/hr | Agile/Scrum |
| Business Analyst | $155/hr | Requirements, UAT |`;

const TRAINING_CONTEXT_PRIVACY = `# Privacy & Compliance Requirements

## Data Handling
- All product images processed in Azure US regions only
- No PII in product images (manufacturing floor only)
- Retention policy: Raw images 90 days, labeled results 7 years

## Access Control
- Azure AD integration for all users
- Role-based access control (RBAC) for data tiers
- Audit logging for all model inference calls

## Compliance
- SOC 2 Type II compliance required
- Annual security assessment by client InfoSec`;

const TRAINING_COST_ESTIMATE = `# Cost Estimate: AI-Powered Product Sample Labeling System

## Executive Summary
This estimate covers a 5-year total cost of ownership for an enterprise AI/ML solution enabling automated product sample labeling across three input channels (industrial scanners, Meta smart glasses, iPhone cameras).

**Estimated Total (5-Year TCO): $1,050,000 - $1,250,000**

---

## Phase Breakdown

### Phase 1: Foundation (Months 1-3)
| Workstream | Hours | Rate | Cost |
|------------|-------|------|------|
| Solution Architecture | 240 | $225 | $54,000 |
| Azure Infrastructure Setup | 160 | $185 | $29,600 |
| ML Environment Configuration | 120 | $200 | $24,000 |
| Project Management | 180 | $165 | $29,700 |
| **Phase 1 Subtotal** | **700** | | **$137,300** |

### Phase 2: Core ML Development (Months 4-6)
| Workstream | Hours | Rate | Cost |
|------------|-------|------|------|
| ML Model Development | 480 | $200 | $96,000 |
| Training Data Pipeline (PySpark) | 200 | $200 | $40,000 |
| Model Training & Tuning | 160 | $200 | $32,000 |
| DevOps/MLOps | 120 | $185 | $22,200 |
| QA & Testing | 80 | $150 | $12,000 |
| Project Management | 140 | $165 | $23,100 |
| **Phase 2 Subtotal** | **1,180** | | **$225,300** |

### Phase 3: Integration & Deployment (Months 7-9)
| Workstream | Hours | Rate | Cost |
|------------|-------|------|------|
| Scanner API Integration | 120 | $175 | $21,000 |
| Meta Smart Glasses App | 200 | $175 | $35,000 |
| iOS Mobile App | 180 | $175 | $31,500 |
| Power BI Dashboard | 80 | $175 | $14,000 |
| UAT & Training | 100 | $150 | $15,000 |
| Business Analysis | 60 | $155 | $9,300 |
| Project Management | 100 | $165 | $16,500 |
| **Phase 3 Subtotal** | **840** | | **$142,300** |

---

## Azure Infrastructure Costs (5-Year)

| Service | Monthly | Annual | 5-Year |
|---------|---------|--------|--------|
| Azure ML Workspace | $3,500 | $42,000 | $210,000 |
| AKS (Inference) | $2,200 | $26,400 | $132,000 |
| Fabric Lakehouse | $4,000 | $48,000 | $240,000 |
| Blob Storage | $800 | $9,600 | $48,000 |
| Azure SQL | $600 | $7,200 | $36,000 |
| Event Grid & Functions | $400 | $4,800 | $24,000 |
| **Infrastructure Total** | **$11,500** | **$138,000** | **$690,000** |

*Note: Year 1 infrastructure prorated for 6 months post-go-live.*

---

## One-Time Costs

| Item | Cost |
|------|------|
| ML Training Compute (Initial) | $15,000 |
| Power BI Pro Licenses (10 seats) | $1,200 |
| Documentation & Knowledge Transfer | $8,000 |
| **One-Time Total** | **$24,200** |

---

## Annual Maintenance (Years 2-5)

| Category | Annual Cost | 4-Year Total |
|----------|-------------|--------------|
| Support & Maintenance (20%) | $50,000 | $200,000 |
| Model Retraining | $15,000 | $60,000 |
| **Maintenance Total** | **$65,000** | **$260,000** |

---

## Risk & Contingency

| Risk Factor | Impact | Contingency |
|-------------|--------|-------------|
| Model accuracy below 95% | High | Additional training iterations (+$20K) |
| Scanner integration complexity | Medium | API middleware (+$15K) |
| Timeline extension | Medium | 15% schedule buffer built in |

**Recommended Contingency: 18% = $90,000**

---

## Total Cost Summary

| Category | Amount |
|----------|--------|
| Labor (Phases 1-3) | $504,900 |
| Azure Infrastructure (5-Year) | $690,000 |
| One-Time Costs | $24,200 |
| Maintenance (Years 2-5) | $260,000 |
| **Subtotal** | **$1,479,100** |
| Less: Year 1 Infrastructure Adjustment | -$69,000 |
| **Adjusted Total** | **$1,410,100** |
| Contingency (18%) | $253,818 |
| **Grand Total (High)** | **$1,663,918** |
| **Grand Total (Low, no contingency)** | **$1,050,000** |

---

## Assumptions
- DC metro labor rates as specified
- Azure consumption based on moderate usage patterns
- Client provides labeled training data within 4 weeks
- No major scope changes during development
- Client IT support available for integration testing`;

const TRAINING_STEPS = [
  {
    id: "intro",
    title: "Welcome to Guide Mode",
    description: "Walk through a real cost estimate from start to finish. You'll create a workspace, add baseline assumptions, context, requirements, and tasks, then review and export your estimate.",
    highlight: null,
    action: null
  },
  {
    id: "createWorkspace",
    title: "Create a workspace",
    description: "Give your estimate a name. All your files (baseline, requirements, tasks, and exports) will live in this workspace.",
    highlight: "createWorkspace",
    action: "createWorkspace"
  },
  {
    id: "baseline",
    title: "Step 1: Establish the Baseline",
    description: "The baseline captures the project overview, scope boundaries (in/out), key assumptions, and constraints. Notice how we document the Azure infrastructure, 5-year planning horizon, and DC labor rates upfront.",
    highlight: "baseline",
    action: null
  },
  {
    id: "context",
    title: "Step 2: Gather Context Documents",
    description: "Context documents give the estimator domain knowledge. Here we've added architecture specs, labor rate cards, and privacy requirements. The richer the context, the more accurate the estimate.",
    highlight: "context",
    action: null
  },
  {
    id: "requirements",
    title: "Step 3: Define Requirements",
    description: "Requirements translate discovery into a pricing-ready brief. We specify goals (80% time reduction), constraints (9-month timeline), acceptance criteria, and pricing inputs like hourly rates.",
    highlight: "requirements",
    action: null
  },
  {
    id: "tasks",
    title: "Step 4: Author the Task Sequence",
    description: "Tasks tell the estimator exactly what to do. The PLAN → EXECUTE → REVIEW → REFINE loop ensures thoroughness. Notice how tasks reference context documents and produce specific deliverables.",
    highlight: "tasks",
    action: null
  },
  {
    id: "estimate",
    title: "Step 5: Review the Cost Estimate",
    description: "After running the estimation, you get a detailed cost breakdown. The cost-estimate.md file shows labor costs by phase, infrastructure costs, contingencies, and a 5-year TCO. Click 'View Estimate' to see the generated output.",
    highlight: "estimate",
    action: "viewEstimate"
  },
  {
    id: "export",
    title: "Step 6: Export Your Estimate",
    description: "Export your estimate as PDF or Word document for stakeholders. Choose your format below to see how the export workflow works.",
    highlight: "export",
    action: "showExport"
  },
  {
    id: "chat",
    title: "Step 7: Refine with Chat",
    description: "Use the Chat panel to refine any document with AI assistance. Ask questions, request changes, or get suggestions. The estimator agent helps you polish your deliverables. Click 'Open Chat' to try it.",
    highlight: "chat",
    action: "openChat"
  },
  {
    id: "complete",
    title: "Training Complete!",
    description: "You've experienced the full Curator workflow: from baseline to export. The training workspace remains available for exploration. Restart anytime from the sidebar or menu bar.",
    highlight: null,
    action: null
  }
];

const CORE_DESCRIPTIONS: Record<WorkspaceFileId, string> = {
  baseline:
    "Baseline captures the engagement overview, scope boundaries, and assumptions.",
  requirements:
    "Requirements define detailed specifications and success criteria for the estimate.",
  tasks:
    "Tasks list the step-by-step instructions the estimator will follow."
};

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  ...CORE_DESCRIPTIONS,
  context:
    "Context documents give the estimator business and technical background."
};

const WIZARD_STEPS = [
  { id: "baseline" as const, label: "Baseline" },
  { id: "context" as const, label: "Context" },
  { id: "requirements" as const, label: "Requirements" },
  { id: "tasks" as const, label: "Tasks" }
];
type WizardStep = (typeof WIZARD_STEPS)[number]["id"];

const REQUIREMENTS_SNIPPETS = {
  goals: "## Goals\n- Business objective\n- In-scope modules\n- Out-of-scope boundaries",
  constraints:
    "## Constraints\n- Timeline\n- Budget guardrails\n- Team/resource limitations",
  acceptance:
    "## Acceptance Criteria\n- Estimate is auditable\n- Assumptions and risks are explicit\n- Stakeholders can sign off",
  pricing:
    "## Pricing Inputs\n- Estimated effort by workstream\n- Rate assumptions\n- Non-labor costs"
} as const;

const normalizeLines = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const detectDelimiter = (text: string) => {
  if (text.includes("\t")) return "\t";
  if (text.includes(",")) return ",";
  if (text.includes(";")) return ";";
  return null;
};

const parseCsvLine = (line: string, delimiter: string) => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields;
};

const parseCsv = (text: string, preferredDelimiter?: string | null) => {
  const delimiter = preferredDelimiter ?? detectDelimiter(text);
  if (!delimiter) return null;
  const lines = normalizeLines(text);
  if (lines.length < 2) return null;
  const rows = lines.map((line) => parseCsvLine(line, delimiter));
  const columnCount = Math.max(...rows.map((row) => row.length));
  if (rows.length < 2 || columnCount < 2) return null;
  return rows;
};

declare global {
  interface Window {
    curator?: {
      openWorkspace: () => Promise<OpenResult>;
      listWorkspaces: () => Promise<{
        root: string;
        workspaces: WorkspaceSummary[];
        activeId: string | null;
      }>;
      openWorkspaceAtPath: (payload: {
        path: string;
      }) => Promise<OpenResult>;
      addWorkspaceFromDialog: () => Promise<WorkspaceSummary | null>;
      setActiveWorkspace: (payload: { id: string }) => Promise<void>;
      saveWorkspaceFile: (payload: {
        root: string;
        id: WorkspaceFileId;
        contents: string;
      }) => Promise<{ id: WorkspaceFileId; path: string; contents: string }>;
      importContextFile: (payload: {
        root: string;
        sourcePath: string;
      }) => Promise<{ name: string; path: string; ext: string }>;
      importTemplateFile: (payload: {
        root: string;
        sourcePath: string;
      }) => Promise<{ name: string; path: string; ext: string }>;
      selectTemplateFiles: (payload: {
        root: string;
      }) => Promise<{ name: string; path: string; ext: string }[]>;
      createTextFile: (payload: {
        root: string;
        name: string;
        contents: string;
      }) => Promise<{ name: string; path: string; ext: string }>;
      createContextDocument: (payload: {
        root: string;
        name: string;
        contents: string;
      }) => Promise<{ name: string; path: string; ext: string }>;
      readTextFile: (payload: {
        root: string;
        path: string;
      }) => Promise<{ path: string; contents: string; ext: string }>;
      getContextDocumentContent: (payload: {
        root: string;
        path: string;
      }) => Promise<{ path: string; contents: string; ext: string }>;
      saveTextFile: (payload: {
        root: string;
        path: string;
        contents: string;
      }) => Promise<{ path: string; contents: string; ext: string }>;
      copyTemplateToDocx: (payload: {
        root: string;
        templatePath: string;
        outputName: string;
      }) => Promise<{ path: string }>;
      openPath: (payload: { path: string }) => Promise<boolean>;
      configGet: () => Promise<{
        provider: string;
        model?: string;
        hasApiKey: boolean;
        apiKeyLast4: string;
        apiKey?: string;
        defaultWorkspaceReady: boolean;
        lastOpenedByWorkspace: Record<
          string,
          { kind: "core"; id: WorkspaceFileId } | { kind: "supplemental"; path: string }
        >;
      }>;
      configSet: (payload: {
        provider?: string;
        model?: string;
        apiKey?: string;
        defaultWorkspaceReady?: boolean;
        lastOpenedByWorkspace?: Record<
          string,
          { kind: "core"; id: WorkspaceFileId } | { kind: "supplemental"; path: string }
        >;
      }) => Promise<{ success: boolean }>;
      closeWindow: () => Promise<void>;
      quitApp: () => Promise<void>;
      selectContextFiles: (payload: {
        root: string;
      }) => Promise<{ name: string; path: string; ext: string }[]>;
      requestPermission: (request: {
        resource: string;
        action: string;
        rationale: string;
      }) => Promise<PermissionResult>;
      createTrainingWorkspace: (payload: {
        baseline: string;
        requirements: string;
        tasks: string;
        contextDocuments: { name: string; contents: string }[];
        costEstimate: string;
      }) => Promise<OpenResult>;
      createWorkspace: (payload: { name: string }) => Promise<OpenResult>;
      dbSaveMessage: (payload: { workspacePath: string; role: string; text: string }) => Promise<void>;
      dbGetMessages: (payload: { workspacePath: string }) => Promise<{ role: string; text: string; timestamp: number }[]>;
      dbSaveSnapshot: (payload: { workspacePath: string; fileId: string; content: string }) => Promise<void>;
      dbGetSnapshots: (payload: { workspacePath: string; fileId: string }) => Promise<{ id: number; content: string; timestamp: number }[]>;
      dbSetLastOpened: (payload: { workspacePath: string; fileId: string }) => Promise<void>;
      dbGetLastOpened: (payload: { workspacePath: string }) => Promise<string | null>;
      searchFiles: (payload: { root: string; query: string; limit?: number }) => Promise<SearchResult[]>;
      searchContext: (payload: { root: string; query: string; limit?: number }) => Promise<SearchResult[]>;
    };
  }
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activeFileId, setActiveFileId] =
    useState<WorkspaceFileId>("baseline");
  const [activeEditor, setActiveEditor] = useState<ActiveEditor>({
    kind: "core",
    id: "baseline"
  });
  const [drafts, setDrafts] = useState<Record<WorkspaceFileId, string>>({
    baseline: "",
    requirements: "",
    tasks: ""
  });
  const [supplementalDrafts, setSupplementalDrafts] = useState<
    Record<string, string>
  >({});
  const [supplementalOriginals, setSupplementalOriginals] = useState<
    Record<string, string>
  >({});
  const [permissionStatus, setPermissionStatus] = useState<
    "unknown" | "granted" | "denied"
  >("unknown");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [contextImporting, setContextImporting] = useState(false);
  const [contextDragActive, setContextDragActive] = useState(false);
  const [templateDragActive, setTemplateDragActive] = useState(false);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>("baseline");
  const [showWizard, setShowWizard] = useState(true);
  const [leftSidebarTab, setLeftSidebarTab] = useState<"workspaces" | "steps">(
    "workspaces"
  );
  const [fileSearch, setFileSearch] = useState("");
  const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [newWorkspaceModalOpen, setNewWorkspaceModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newContextOpen, setNewContextOpen] = useState(false);
  const [newContextName, setNewContextName] = useState("");
  const [newContextContents, setNewContextContents] = useState("");
  const [baselineGuideOpen, setBaselineGuideOpen] = useState(false);
  const [requirementsGuideOpen, setRequirementsGuideOpen] = useState(false);
  const [tasksGuideOpen, setTasksGuideOpen] = useState(false);
  const [guideOpenByStep, setGuideOpenByStep] = useState<
    Record<WizardStep, boolean>
  >({
    baseline: false,
    requirements: false,
    tasks: false,
    context: false
  });
  const [coreOpen, setCoreOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(true);
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [csvPreviewOpen, setCsvPreviewOpen] = useState(false);
  const [showDocxFlow, setShowDocxFlow] = useState(false);
  const [selectedTemplatePath, setSelectedTemplatePath] = useState<string>("");
  const [docxStatus, setDocxStatus] = useState("");
  const [costEstimateFile, setCostEstimateFile] =
    useState<WorkspaceSupplementalFile | null>(null);
  const [docxOutputPath, setDocxOutputPath] = useState("");
  const [docxReady, setDocxReady] = useState(false);
  const [executionMode, setExecutionMode] = useState(false);
  const [executionTasks, setExecutionTasks] = useState<
    { id: string; text: string; status: "pending" | "running" | "completed" }[]
  >([]);
  const [examplesDocked, setExamplesDocked] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<
    "details" | "copilot" | "chat" | "settings"
  >("copilot");
  const [chatMessages, setChatMessages] = useState<
    { role: "user" | "agent"; text: string }[]
  >([]);
  const [chatInput, setChatInput] = useState("");
  const [agentRefineActive, setAgentRefineActive] = useState(false);
  const [mainTab, setMainTab] = useState<"editor" | "insights">("editor");
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsStatus, setInsightsStatus] = useState("");
  const [aiInsights, setAiInsights] = useState<InsightPayload | null>(null);
  const [previewEditId, setPreviewEditId] = useState<string | null>(null);
  const [settingsProvider, setSettingsProvider] = useState("openrouter");
  const [settingsModel, setSettingsModel] = useState("openai/gpt-4o-mini");
  const [chatMode, setChatMode] = useState<"ask" | "agent">("agent");
  const [chatModeMenuOpen, setChatModeMenuOpen] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [settingsApiKey, setSettingsApiKey] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsKeySuffix, setSettingsKeySuffix] = useState("");
  const [settingsHasKey, setSettingsHasKey] = useState(false);
  const [defaultWorkspaceReady, setDefaultWorkspaceReady] = useState(false);
  const [lastOpenedByWorkspace, setLastOpenedByWorkspace] = useState<
    Record<
      string,
      { kind: "core"; id: WorkspaceFileId } | { kind: "supplemental"; path: string }
    >
  >({});
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceList, setWorkspaceList] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null
  );
  const [trainingMode, setTrainingMode] = useState(false);
  const [trainingStepIndex, setTrainingStepIndex] = useState(0);
  const [trainingOriginalDrafts, setTrainingOriginalDrafts] = useState<Record<
    WorkspaceFileId,
    string
  > | null>(null);
  
  // Panel layout state
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [editorWidth, setEditorWidth] = useState(65); // percentage
  const [isResizing, setIsResizing] = useState(false);
  const [chatContextFiles, setChatContextFiles] = useState<File[]>([]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);

  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);
  const [copilotScenario, setCopilotScenario] = useState<EstimateScenarioId>("expected");

  const workspaceManager = useMemo(() => new WorkspaceManager(), []);
  const permissionGate = useMemo(() => new PermissionGate(), []);
  const editorController = useMemo(() => new EditorController(), []);
  const helpSections = useMemo(() => parseHelpSections(helpKbRaw), []);
  const markdownExtensions = useMemo(
    () => new Set([".md", ".markdown"]),
    []
  );

  const contextExtensions = useMemo(
    () =>
      new Set([
        ".txt",
        ".md",
        ".markdown",
        ".csv",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".conf",
        ".log",
        ".env",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".mjs",
        ".cjs",
        ".css",
        ".scss",
        ".html",
        ".xml",
        ".sql",
        ".py",
        ".rb",
        ".go",
        ".rs",
        ".php",
        ".java",
        ".kt",
        ".swift",
        ".c",
        ".cpp",
        ".h",
        ".hpp",
        ".cs",
        ".ps1",
        ".sh",
        ".docx",
        ".pdf",
        ".pptx",
        ".xlsx"
      ]),
    []
  );
  const templateExtensions = useMemo(
    () => new Set([".docx", ".dot"]),
    []
  );

  const defaultContents = (id: WorkspaceFileId) => {
    switch (id) {
      case "baseline":
        return "# Baseline\n\n";
      case "requirements":
        return "# Requirements\n\n";
      case "tasks":
        return "# Tasks\n\n";
      default:
        return "";
    }
  };

  const persistLastOpened = async (
    workspaceId: string | null,
    entry:
      | { kind: "core"; id: WorkspaceFileId }
      | { kind: "supplemental"; path: string }
  ) => {
    if (!workspaceId || !workspace) return;
    try {
      // Use SQLite for persistence if available
      if (window.curator?.dbSetLastOpened) {
        const value = JSON.stringify(entry);
        await window.curator.dbSetLastOpened({
          workspacePath: workspace.root,
          fileId: value
        });
      }
      
      // Fallback/Sync to config for now (optional, but good for transition)
      setLastOpenedByWorkspace((current) => {
        const next = { ...current, [workspaceId]: entry };
        window.curator?.configSet({ lastOpenedByWorkspace: next });
        return next;
      });
    } catch (e) {
      console.error("Failed to persist last opened", e);
    }
  };

  const setActiveCoreFile = (fileId: WorkspaceFileId) => {
    setActiveFileId(fileId);
    setActiveEditor({ kind: "core", id: fileId });
    setShowDocxFlow(false);
    persistLastOpened(activeWorkspaceId, { kind: "core", id: fileId });
  };

  const loadWorkspace = async (
    entry: WorkspaceSummary,
    requirePermission: boolean,
    source: "auto" | "add" | "switch" | "refresh" = "switch"
  ) => {
    setOpeningWorkspace(true);
    setStatusMessage("");
    if (requirePermission) {
      const permitted = await permissionGate.request({
        resource: "workspace",
        action: "read",
        rationale:
          "Curator needs access to load your estimate files from this workspace.",
        workspacePath: entry.path
      });
      setPermissionStatus(permitted ? "granted" : "denied");
      if (!permitted) {
        setStatusMessage("Permission denied.");
        setOpeningWorkspace(false);
        return;
      }
    }

    try {
      const result = await workspaceManager.openWorkspaceAtPath(entry.path);
      const initialFile = WORKSPACE_FILE_ORDER[0];
      const nextDrafts = WORKSPACE_FILE_ORDER.reduce(
        (acc, id) => {
          acc[id] = result.files[id].contents;
          return acc;
        },
        {} as Record<WorkspaceFileId, string>
      );
      const shouldShowWizard =
        source === "add" ||
        (!defaultWorkspaceReady && entry.id === "default");
      setWorkspace(result);
      setActiveWorkspaceId(entry.id);
      setActiveCoreFile(initialFile);
      setDrafts(nextDrafts);
      setFileSearch("");
      setFileSearchResults([]);
      setMainTab("editor");
      setAiInsights(null);
      setInsightsStatus("");
      setShowWizard(shouldShowWizard);
      setShowDocxFlow(false);
      setWizardStep("baseline");
      await workspaceManager.setActiveWorkspace(entry.id);
      setStatusMessage(`Workspace loaded: ${entry.name}`);

      // Load Chat History
      if (window.curator?.dbGetMessages) {
        try {
          const history = await window.curator.dbGetMessages({ workspacePath: result.root });
          setChatMessages(history.map(m => ({ role: m.role as "user" | "agent", text: m.text })));
        } catch (e) {
          console.error("Failed to load chat history", e);
        }
      }

      if (!shouldShowWizard) {
        let lastOpened = lastOpenedByWorkspace[entry.id];
        
        // Try DB for last opened
        if (window.curator?.dbGetLastOpened) {
          try {
            const dbLastOpened = await window.curator.dbGetLastOpened({ workspacePath: result.root });
            if (dbLastOpened) {
              lastOpened = JSON.parse(dbLastOpened);
            }
          } catch (e) {
            console.error("Failed to load last opened from DB", e);
          }
        }

        if (lastOpened?.kind === "core") {
          setActiveCoreFile(lastOpened.id);
        } else if (lastOpened?.kind === "supplemental") {
          const file =
            result.markdownFiles.find(
              (item) => item.path === lastOpened.path
            ) ||
            result.contextDocuments.find(
              (item) => item.path === lastOpened.path
            );
          if (file) {
            await openSupplementalFile(file);
          }
        }
      }
      setPreviewEditId(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Open failed.");
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const refreshActiveWorkspace = async () => {
    if (openingWorkspace) return;
    const activeEntry = workspaceList.find((item) => item.id === activeWorkspaceId);
    if (!activeEntry) {
      setStatusMessage("No active workspace to refresh.");
      return;
    }
    setStatusMessage("Refreshing workspace…");
    await loadWorkspace(activeEntry, false, "refresh");
  };

  const copyWorkspacePath = async () => {
    if (!workspaceRoot) {
      setStatusMessage("No workspace path to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(workspaceRoot);
      setStatusMessage("Path copied to clipboard.");
    } catch {
      setStatusMessage("Could not copy path.");
    }
  };

  const addWorkspace = async () => {
    setNewWorkspaceModalOpen(true);
  };

  const handleCreateWorkspace = async () => {
    if (openingWorkspace) return;
    const name = newWorkspaceName.trim();
    if (!name) {
      setStatusMessage("Workspace name is required.");
      return;
    }
    
    setOpeningWorkspace(true);
    setStatusMessage("");
    try {
      if (!window.curator?.createWorkspace) {
        throw new Error("Create workspace API not available");
      }
      
      const entry = await window.curator.createWorkspace({ name });
      if (!entry) {
        setStatusMessage("Failed to create workspace.");
        return;
      }
      
      const summary: WorkspaceSummary = {
        id: entry.id || "unknown",
        name: entry.name ?? "Workspace",
        path: entry.root
      };
      
      setWorkspaceList((current) => {
        const exists = current.some((item) => item.id === summary.id);
        return exists ? current : [...current, summary];
      });
      
      setNewWorkspaceModalOpen(false);
      setNewWorkspaceName("");
      await loadWorkspace(summary, true, "add");
      if (trainingMode && trainingStepIndex === 1) {
        setTrainingStepIndex(2);
        navigateToTrainingStep(TRAINING_STEPS[2]);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Creation failed.");
    } finally {
      setOpeningWorkspace(false);
    }
  };

  const handleSwitchFile = (fileId: WorkspaceFileId) => {
    if (!workspace) return;
    if (fileId === activeFileId) return;
    setActiveCoreFile(fileId);
    setShowWizard(false); // Exit wizard when clicking a file
  };

  const isDirty = (fileId: WorkspaceFileId) => {
    if (!workspace) return false;
    return drafts[fileId] !== workspace.files[fileId]?.contents;
  };

  const handleDraftChange = (value: string) => {
    setDrafts((current) => ({ ...current, [activeFileId]: value }));
  };

  const queuePendingEdit = (edit: Omit<PendingEdit, "id">) => {
    setPendingEdits((prev) => [
      ...prev,
      {
        ...edit,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      }
    ]);
  };

  const focusContextCollection = () => {
    setLeftSidebarTab("workspaces");
    setShowWizard(true);
    setWizardStep("context");
    setStatusMessage(
      "Add supporting context documents from the workspace panel or chat attachments."
    );
  };

  const queueCopilotQuestion = (
    target: "baseline" | "requirements" | "tasks",
    question: string
  ) => {
    const currentContent = drafts[target] ?? "";
    const heading = "## Open Questions";
    const nextBlock = `${heading}\n- ${question}`;
    const newContent = currentContent.includes(heading)
      ? `${currentContent.trimEnd()}\n- ${question}\n`
      : `${currentContent.trimEnd()}\n\n${nextBlock}\n`;

    queuePendingEdit({
      fileId: target,
      kind: "core",
      originalContent: currentContent,
      newContent,
      label: `${target}.md`
    });
    setStatusMessage(`Queued question for ${target}.md`);
  };

  const queueCopilotEstimate = async () => {
    if (!workspace) return;
    const nextContent = buildCostEstimateMarkdown(copilotModel, activeScenario);
    const existing =
      workspace.markdownFiles.find((file) => file.name === "cost-estimate.md") ?? null;

    if (existing) {
      let originalContent =
        supplementalDrafts[existing.path] ??
        supplementalOriginals[existing.path] ??
        "";
      if (!originalContent) {
        try {
          const loaded = await workspaceManager.readTextFile(workspace, existing.path);
          originalContent = loaded.contents;
        } catch {
          originalContent = "";
        }
      }
      queuePendingEdit({
        fileId: existing.path,
        kind: "supplemental",
        originalContent,
        newContent: nextContent,
        label: existing.name
      });
    } else {
      queuePendingEdit({
        fileId: "cost-estimate.md",
        kind: "newSupplemental",
        originalContent: "",
        newContent: nextContent,
        label: "cost-estimate.md"
      });
    }
    setStatusMessage("Queued a proposed estimate brief for review.");
  };

  const acceptEdit = async (edit: PendingEdit) => {
    if (!workspace) return;
    
    try {
      // Save snapshot of OLD content
      if (window.curator?.dbSaveSnapshot) {
        await window.curator.dbSaveSnapshot({
          workspacePath: workspace.root,
          fileId: edit.fileId,
          content: edit.originalContent
        });
      }

      // Apply NEW content
      if (edit.kind === "core") {
        await window.curator?.saveWorkspaceFile({
          root: workspace.root,
          id: edit.fileId as WorkspaceFileId,
          contents: edit.newContent
        });
        setDrafts((prev) => ({
          ...prev,
          [edit.fileId as WorkspaceFileId]: edit.newContent
        }));
        setActiveCoreFile(edit.fileId as WorkspaceFileId);
      } else if (edit.kind === "supplemental") {
        await window.curator?.saveTextFile({
          root: workspace.root,
          path: edit.fileId,
          contents: edit.newContent
        });
        setSupplementalDrafts((prev) => ({ ...prev, [edit.fileId]: edit.newContent }));
        setSupplementalOriginals((prev) => ({ ...prev, [edit.fileId]: edit.newContent }));
        const match =
          workspace.markdownFiles.find((file) => file.path === edit.fileId) ||
          workspace.contextDocuments.find((file) => file.path === edit.fileId);
        if (match) {
          await openSupplementalFile(match);
        }
      } else {
        const created = await workspaceManager.createTextFile(
          workspace,
          edit.fileId,
          edit.newContent
        );
        setWorkspace((current) => {
          if (!current) return current;
          return {
            ...current,
            markdownFiles: [...current.markdownFiles, created].sort((a, b) =>
              a.name.localeCompare(b.name)
            )
          };
        });
        setSupplementalDrafts((prev) => ({ ...prev, [created.path]: edit.newContent }));
        setSupplementalOriginals((prev) => ({ ...prev, [created.path]: edit.newContent }));
        await openSupplementalFile(created);
      }
      
      // Remove from pending
      setPendingEdits(prev => prev.filter(p => p.id !== edit.id));
      if (previewEditId === edit.id) {
        setPreviewEditId(null);
      }
      
      // Refresh workspace if needed
      await refreshActiveWorkspace();
      setStatusMessage(`Applied changes to ${edit.label}`);
    } catch (error) {
      setStatusMessage("Failed to apply edit.");
      console.error(error);
    }
  };

  const rejectEdit = (edit: PendingEdit) => {
    setPendingEdits((prev) => prev.filter((p) => p.id !== edit.id));
    if (previewEditId === edit.id) {
      setPreviewEditId(null);
    }
    setStatusMessage(`Rejected changes to ${edit.label}`);
  };

  const saveFile = async (fileId: WorkspaceFileId) => {
    if (!workspace) return;
    setStatusMessage("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to save your changes to this workspace.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      // Save snapshot before overwriting (or after? usually after for history)
      if (window.curator?.dbSaveSnapshot) {
        await window.curator.dbSaveSnapshot({
          workspacePath: workspace.root,
          fileId: fileId,
          content: drafts[fileId]
        });
      }

      const saved = await workspaceManager.saveWorkspaceFile(
        workspace,
        fileId,
        drafts[fileId]
      );
      setWorkspace((current) => {
        if (!current) return current;
        const nextMissing = current.missing.filter((id) => id !== saved.id);
        return {
          ...current,
          files: { ...current.files, [saved.id]: saved },
          missing: nextMissing
        };
      });
      setPermissionStatus("granted");
      setStatusMessage("File saved.");
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const saveActiveFile = async () => {
    await saveFile(activeFileId);
  };

  const openSupplementalFile = async (
    file: WorkspaceSupplementalFile
  ): Promise<void> => {
    if (!workspace) return;
    setStatusMessage("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "read",
      rationale: "Curator needs to load this file for editing.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      const result = await workspaceManager.readTextFile(workspace, file.path);
      setSupplementalDrafts((current) => ({
        ...current,
        [file.path]: result.contents
      }));
      setSupplementalOriginals((current) => ({
        ...current,
        [file.path]: result.contents
      }));
      setActiveEditor({
        kind: "supplemental",
        file,
        isMarkdown:
          markdownExtensions.has(file.ext) ||
          [".pdf", ".docx", ".pptx", ".xlsx"].includes(file.ext)
      });
      setShowWizard(false);
      setShowDocxFlow(false);
      await persistLastOpened(activeWorkspaceId, {
        kind: "supplemental",
        path: file.path
      });
      setPermissionStatus("granted");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Open failed."
      );
    }
  };

  const openSearchResult = async (result: SearchResult) => {
    if (!workspace) return;
    const coreMatch = WORKSPACE_FILE_ORDER.find((id) => {
      const corePath = workspace.files[id]?.path;
      if (corePath && corePath === result.path) return true;
      const name = basenameLike(result.path).toLowerCase();
      return name === `${id}.md`;
    });
    if (coreMatch) {
      handleSwitchFile(coreMatch);
      return;
    }
    await openSupplementalFile({
      name: result.name,
      path: result.path,
      ext: result.ext
    });
  };

  const saveSupplementalFile = async (file: WorkspaceSupplementalFile) => {
    if (!workspace) return;
    setStatusMessage("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to save your changes.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      const contents = supplementalDrafts[file.path] ?? "";
      
      if (window.curator?.dbSaveSnapshot) {
        await window.curator.dbSaveSnapshot({
          workspacePath: workspace.root,
          fileId: file.path,
          content: contents
        });
      }

      const saved = await workspaceManager.saveTextFile(
        workspace,
        file.path,
        contents
      );
      setSupplementalOriginals((current) => ({
        ...current,
        [file.path]: saved.contents
      }));
      setPermissionStatus("granted");
      setStatusMessage("File saved.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Save failed."
      );
    }
  };

  const createMissingFiles = async () => {
    if (!workspace || workspace.missing.length === 0) return;
    setStatusMessage("");
    const missingToCreate = [...workspace.missing];
    const firstMissing = WORKSPACE_FILE_ORDER.find((id) =>
      missingToCreate.includes(id)
    );
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to create the required estimate files.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      let nextWorkspace = workspace;
      let nextDrafts = { ...drafts };
      for (const id of missingToCreate) {
        const contents =
          drafts[id].trim().length > 0 ? drafts[id] : defaultContents(id);
        const saved = await workspaceManager.saveWorkspaceFile(
          nextWorkspace,
          id,
          contents
        );
        nextWorkspace = {
          ...nextWorkspace,
          files: { ...nextWorkspace.files, [saved.id]: saved },
          missing: nextWorkspace.missing.filter((entry) => entry !== saved.id)
        };
        nextDrafts = { ...nextDrafts, [saved.id]: saved.contents };
      }
      setWorkspace(nextWorkspace);
      setDrafts(nextDrafts);
      if (firstMissing) {
        setActiveFileId(firstMissing);
      }
      setPermissionStatus("granted");
      setStatusMessage("Missing files created.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Create failed."
      );
    }
  };

  const getFileExtension = (name: string) => {
    const index = name.lastIndexOf(".");
    if (index === -1) return "";
    return name.slice(index).toLowerCase();
  };

  const handleDrop = async (
    event: DragEvent<HTMLDivElement>,
    target: "context" | "template"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (target === "context") setContextDragActive(false);
    if (target === "template") setTemplateDragActive(false);
    if (!workspace) return;

    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    if (
      target === "context" &&
      workspace.contextDocuments.length >= MAX_CONTEXT_DOCUMENTS
    ) {
      setStatusMessage(
        `Maximum ${MAX_CONTEXT_DOCUMENTS} supporting documents. Remove one to add another.`
      );
      return;
    }

    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale:
        target === "context"
          ? "Curator needs to import your reference documents."
          : "Curator needs to import the template.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    const allowed =
      target === "context" ? contextExtensions : templateExtensions;
    const invalidFiles: string[] = [];
    const imported: string[] = [];
    const remainingContextSlots =
      target === "context"
        ? Math.max(
            0,
            MAX_CONTEXT_DOCUMENTS - workspace.contextDocuments.length
          )
        : Infinity;

    if (target === "context") {
      setContextImporting(true);
      setStatusMessage("Importing supporting documents…");
    }

    try {
      for (const file of droppedFiles) {
        if (imported.length >= remainingContextSlots) break;
        const path = (file as File & { path?: string }).path;
        const ext = getFileExtension(file.name);
        if (!allowed.has(ext)) {
          invalidFiles.push(file.name);
          continue;
        }
        if (!path) {
          invalidFiles.push(file.name);
          continue;
        }

        try {
          const saved =
            target === "context"
              ? await workspaceManager.importContextFile(workspace, path)
              : await workspaceManager.importTemplateFile(workspace, path);
          imported.push(saved.name);
          setWorkspace((current) => {
            if (!current) return current;
            const listKey =
              target === "context" ? "contextDocuments" : "templates";
            const existing = current[listKey];
            const updated = [...existing, saved].sort((a, b) =>
              a.name.localeCompare(b.name)
            );
            return { ...current, [listKey]: updated };
          });
        } catch (error) {
          invalidFiles.push(file.name);
        }
      }

      setPermissionStatus("granted");
      if (imported.length && invalidFiles.length) {
        setStatusMessage(
          `Imported ${imported.length} file(s). Skipped ${invalidFiles.length} file(s).`
        );
      } else if (imported.length) {
        setStatusMessage(`Imported ${imported.length} file(s).`);
      } else if (invalidFiles.length) {
        setStatusMessage("No files imported. Unsupported file types.");
      }
    } finally {
      if (target === "context") {
        setContextImporting(false);
      }
    }
  };

  const startContextUpload = async () => {
    if (!workspace) return;
    if (contextImporting) return;
    if (workspace.contextDocuments.length >= MAX_CONTEXT_DOCUMENTS) {
      setStatusMessage(
        `Maximum ${MAX_CONTEXT_DOCUMENTS} supporting documents. Remove one to add another.`
      );
      return;
    }
    setStatusMessage("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to import your reference documents.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      setContextImporting(true);
      setStatusMessage("Importing supporting documents…");
      const imported = await workspaceManager.selectContextFiles(workspace);
      if (imported.length === 0) {
        setStatusMessage("No files selected.");
        return;
      }
      setWorkspace((current) => {
        if (!current) return current;
        const updated = [...current.contextDocuments, ...imported].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
        return { ...current, contextDocuments: updated };
      });
      setPermissionStatus("granted");
      setStatusMessage(
        `Imported ${imported.length} file(s). Conversions run in the background.`
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Import failed."
      );
    } finally {
      setContextImporting(false);
    }
  };

  const startTemplateUpload = async () => {
    if (!workspace) return;
    setStatusMessage("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to import the template.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      const imported = await workspaceManager.selectTemplateFiles(workspace);
      if (imported.length === 0) {
        setStatusMessage("No templates selected.");
        return;
      }
      setWorkspace((current) => {
        if (!current) return current;
        const updated = [...current.templates, ...imported].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
        return { ...current, templates: updated };
      });
      setPermissionStatus("granted");
      setStatusMessage(`Imported ${imported.length} template(s).`);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Template import failed."
      );
    }
  };

  const generateEstimateMarkdown = async () => {
    if (!workspace) return;
    setDocxStatus("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to create the cost estimate file.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setDocxStatus("Permission denied.");
      return;
    }

    const contents = `# Cost Estimate\n\n## Summary\n- Project overview:\n- Scope highlights:\n\n## Assumptions\n- \n\n## Estimate Table\n| Item | Notes | Cost |\n| --- | --- | --- |\n|  |  |  |\n`;
    try {
      await upsertCostEstimateFile(contents);
      setShowDocxFlow(true);
      setDocxStatus("Cost estimate draft created.");
      setPermissionStatus("granted");
    } catch (error) {
      setDocxStatus(
        error instanceof Error ? error.message : "Draft generation failed."
      );
    }
  };

  const generateDocx = async () => {
    if (!workspace) return;
    if (!selectedTemplatePath) {
      setDocxStatus("Select a template first.");
      return;
    }
    setDocxStatus("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to export your estimate document.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setDocxStatus("Permission denied.");
      return;
    }

    try {
      const result = await workspaceManager.copyTemplateToDocx(
        workspace,
        selectedTemplatePath,
        "cost-estimate.docx"
      );
      setDocxOutputPath(result.path);
      setDocxReady(true);
      setDocxStatus("DOCX created.");
      setPermissionStatus("granted");
    } catch (error) {
      setDocxStatus(
        error instanceof Error ? error.message : "DOCX generation failed."
      );
    }
  };

  const openDocx = async () => {
    if (!docxOutputPath) return;
    try {
      await workspaceManager.openPath(docxOutputPath);
    } catch (error) {
      setDocxStatus(
        error instanceof Error ? error.message : "Unable to open DOCX."
      );
    }
  };

  const upsertCostEstimateFile = async (contents: string) => {
    if (!workspace) return null;
    if (costEstimateFile) {
      await workspaceManager.saveTextFile(
        workspace,
        costEstimateFile.path,
        contents
      );
      return costEstimateFile;
    }
    const created = await workspaceManager.createTextFile(
      workspace,
      "cost-estimate.md",
      contents
    );
    setCostEstimateFile(created);
    setWorkspace((current) => {
      if (!current) return current;
      const exists = current.markdownFiles.some(
        (file) => file.path === created.path
      );
      const updated = exists
        ? current.markdownFiles
        : [...current.markdownFiles, created].sort((a, b) =>
            a.name.localeCompare(b.name)
          );
      return { ...current, markdownFiles: updated };
    });
    return created;
  };

  const regenerateCostEstimate = async () => {
    if (!workspace) return;
    setInsightsStatus("");
    setInsightsLoading(true);
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to update the cost estimate.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setInsightsStatus("Permission denied.");
      setInsightsLoading(false);
      return;
    }

    try {
      const config = await window.curator?.configGet();
      if (!config?.apiKey) {
        setInsightsStatus("Add an API key in Settings to generate estimates.");
        setInsightsLoading(false);
        return;
      }

      const contextParts: string[] = [];
      if (drafts.baseline) {
        contextParts.push(`## Baseline\n${drafts.baseline}`);
      }
      if (drafts.requirements) {
        contextParts.push(`## Requirements\n${drafts.requirements}`);
      }
      if (drafts.tasks) {
        contextParts.push(`## Tasks\n${drafts.tasks}`);
      }
      const supplemental = [
        ...(workspace?.contextDocuments ?? []),
        ...(workspace?.markdownFiles ?? [])
      ].slice(0, 6);
      for (const doc of supplemental) {
        try {
          const { contents } = await workspaceManager.readTextFile(
            workspace,
            doc.path
          );
          if (contents?.trim()) {
            const trimmed =
              contents.length > 2000
                ? `${contents.slice(0, 2000)}\n…(truncated)`
                : contents;
            contextParts.push(`## Supporting: ${doc.name}\n${trimmed}`);
          }
        } catch {
          // ignore unreadable docs
        }
      }

      const systemPrompt = `You are a cost estimation assistant. Produce a finance-ready cost estimate markdown plus an insights summary. Return ONLY a JSON payload in a code block with language "curator_insights".

Schema:
{
  "costEstimateMarkdown": "markdown string",
  "insights": {
    "summary": "short executive summary",
    "rangeLow": 123456,
    "rangeHigh": 234567,
    "confidence": 72,
    "confidenceLabel": "Moderate confidence",
    "scenarioLabel": "Expected",
    "scenarioNarrative": "short sentence",
    "drivers": [
      {"label":"Labor shape","category":"Labor","impact":"high","description":"...","sources":["Baseline","Requirements"]}
    ],
    "savings": [
      {"label":"Reuse existing assets","category":"Labor","impact":"medium","description":"...","sources":["Context docs"]}
    ]
  }
}

Rules:
- Provide 3-5 drivers and 2-4 savings levers.
- Categories should be short (Labor, Data volume, Operations, Infrastructure, Governance, Process).
- Impacts must be one of: high, medium, low.
- Use numeric USD values for rangeLow/rangeHigh.
- Keep markdown concise and structured with headings and a cost table.`;

      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "HTTP-Referer": "https://curator.local",
            "X-OpenRouter-Title": "Curator Cost Estimator",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: settingsModel,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `Workspace context:\n${contextParts.join("\n\n")}`
              }
            ]
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error?.message || `API error: ${response.status}`
        );
      }

      const data = await response.json();
      const assistantMessage =
        data.choices?.[0]?.message?.content || "No response received.";
      const parsed = parseCuratorInsights(assistantMessage);
      if (!parsed) {
        throw new Error("Could not parse cost estimate response.");
      }

      await upsertCostEstimateFile(parsed.costEstimateMarkdown);
      setAiInsights(parsed.insights);
      setInsightsStatus("Cost estimate updated.");
      setMainTab("insights");
      setPermissionStatus("granted");
    } catch (error) {
      setInsightsStatus(
        error instanceof Error ? error.message : "Estimate generation failed."
      );
    } finally {
      setInsightsLoading(false);
    }
  };

  const startChatRefinement = async () => {
    if (costEstimateFile) {
      await openSupplementalFile(costEstimateFile);
    }
    setRightPanelOpen(true);
    setRightPanelTab("chat");
    setShowDocxFlow(false);
  };

  const sendChatMessage = async () => {
    const message = chatInput.trim();
    if (!message && chatContextFiles.length === 0) return;
    
    // If there are context files, save them first
    if (chatContextFiles.length > 0 && workspace) {
      for (const file of chatContextFiles) {
        try {
          const contents = await file.text();
          await window.curator?.createContextDocument({ root: workspace.root, name: file.name, contents });
        } catch (error) {
          console.error("Failed to save context file:", error);
        }
      }
      
      // Refresh workspace to show new files
      await refreshActiveWorkspace();
      
      const fileNames = chatContextFiles.map((f) => f.name).join(", ");
      setChatMessages((current) => [
        ...current,
        { role: "user", text: message || `Added context files: ${fileNames}` },
        {
          role: "agent",
          text: `I've added ${chatContextFiles.length} file(s) to the context-documents folder: ${fileNames}. These will be used for cost estimation analysis.`
        }
      ]);
      setChatContextFiles([]);
      setChatInput("");
      return;
    }
    
    // Add user message to chat
    const userMsg = { role: "user" as const, text: message };
    setChatMessages((current) => [...current, userMsg]);
    setChatInput("");
    setChatLoading(true);

    if (workspace && window.curator?.dbSaveMessage) {
      window.curator.dbSaveMessage({
        workspacePath: workspace.root,
        role: "user",
        text: message
      }).catch(e => console.error("Failed to save user message", e));
    }

    const helpResponse = getHelpResponse(message, helpSections);
    if (helpResponse) {
      const responseText = `**${helpResponse.title}**\n\n${helpResponse.body}`;
      setChatMessages((current) => [
        ...current,
        { role: "agent", text: responseText }
      ]);
      if (workspace && window.curator?.dbSaveMessage) {
        window.curator.dbSaveMessage({
          workspacePath: workspace.root,
          role: "agent",
          text: responseText
        }).catch((e) => console.error("Failed to save agent message", e));
      }
      setChatLoading(false);
      return;
    }
    
    // Get API key from config
    try {
      const config = await window.curator?.configGet();
      if (!config?.apiKey) {
        setChatMessages((current) => [
          ...current,
          { role: "agent", text: "Please configure your OpenRouter API key in Settings first." }
        ]);
        setChatLoading(false);
        return;
      }
      
      // Build context from current workspace files
      const contextParts: string[] = [];
      if (drafts.baseline) {
        contextParts.push(`## Baseline Document\n${drafts.baseline}`);
      }
      if (drafts.requirements) {
        contextParts.push(`## Requirements Document\n${drafts.requirements}`);
      }
      if (drafts.tasks) {
        contextParts.push(`## Tasks Document\n${drafts.tasks}`);
      }
      if (workspace) {
        const supplementalCandidates = [
          ...workspace.contextDocuments,
          ...workspace.markdownFiles
        ];
        if (supplementalCandidates.length > 0) {
          let matches: SearchResult[] = [];
          if (message.trim()) {
            matches = await workspaceManager.searchContext(
              workspace,
              message.trim(),
              6
            );
          }
          const corePaths = new Set(
            WORKSPACE_FILE_ORDER.map((id) => workspace.files[id]?.path).filter(
              Boolean
            )
          );
          const selected = matches.length
            ? matches
            : supplementalCandidates.slice(0, 6).map((file) => ({
                path: file.path,
                name: file.name,
                ext: file.ext,
                snippet: "",
                score: 0
              }));
          const seen = new Set<string>();
          for (const match of selected) {
            if (!match.path || seen.has(match.path) || corePaths.has(match.path)) {
              continue;
            }
            seen.add(match.path);
            try {
              const { contents } = await workspaceManager.readTextFile(
                workspace,
                match.path
              );
              if (contents?.trim()) {
                const trimmed =
                  contents.length > MAX_CHAT_CONTEXT_CHARS
                    ? `${contents.slice(0, MAX_CHAT_CONTEXT_CHARS)}\n…(truncated)`
                    : contents;
                contextParts.push(`## Relevant: ${match.name}\n${trimmed}`);
              }
            } catch {
              // skip failed loads
            }
          }
        }
      }

      // Get current file being edited
      let currentFileContent = "";
      if (activeEditor.kind === "core") {
        currentFileContent = drafts[activeEditor.id] || "";
      } else if (activeEditor.kind === "supplemental") {
        currentFileContent = supplementalDrafts[activeEditor.file.path] || "";
      }
      
      const supplementalDescriptors =
        workspace?.markdownFiles
          ?.map((f) => `${f.name} (${f.path})`)
          .join(", ") ?? "";
      const systemPrompt = `You are a cost estimation assistant for IT projects. You help users refine their cost estimates, analyze requirements, and improve their estimation documents.${chatMode === "agent" ? " You can also apply edits directly to workspace files." : ""}

Current workspace context:
${contextParts.join("\n\n")}

${currentFileContent ? `Currently focused/editing:\n${currentFileContent}` : ""}

Allowed workspace files you can edit:
- Core documents (use exactly these ids): baseline, requirements, tasks
- Supplemental markdown/context files (you may use either file name or full path): ${supplementalDescriptors || "none listed"}

When the user asks you to change, add, or update content in a file, ${
        chatMode === "agent"
          ? "you may apply the edit by including a JSON block in your response with this exact format (use the exact code block language curator_edits):"
          : "respond with guidance only. Do NOT include curator_edits blocks and do NOT attempt direct file edits."
      }
\`\`\`curator_edits
{"edits":[{"file":"baseline","content":"full new content of the file"},{"file":"cost-estimate.md","content":"full new content"}]}
\`\`\`

Rules: Use "file" value "baseline", "requirements", or "tasks" for core documents; for supplemental files use either exact name (e.g. cost-estimate.md) or full path from the list above. If you need to create a new file, specify the filename (e.g. risk-notes.md). Provide the complete new file content in "content". You can include multiple edits in one block. Also write a short human-readable reply before or after the block. If the user is only asking a question (no edit), respond normally without a curator_edits block.`;

      // Build conversation history for API
      const apiMessages = [
        { role: "system", content: systemPrompt },
        ...chatMessages.map((m) => ({
          role: m.role === "agent" ? "assistant" : "user",
          content: m.text
        })),
        { role: "user", content: message }
      ];
      
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "HTTP-Referer": "https://curator.local",
          "X-OpenRouter-Title": "Curator Cost Estimator",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: settingsModel,
          messages: apiMessages
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
      }
      
      const data = await response.json();
      let assistantMessage = data.choices?.[0]?.message?.content || "No response received.";
      
      if (workspace && window.curator?.dbSaveMessage) {
        window.curator.dbSaveMessage({
          workspacePath: workspace.root,
          role: "agent",
          text: assistantMessage
        }).catch(e => console.error("Failed to save agent message", e));
      }

      const payload = parseCuratorEdits(assistantMessage);
      const applied: string[] = [];
      if (payload && chatMode === "agent" && workspace && payload.edits.length > 0) {
        const newPending: typeof pendingEdits = [];
        for (const { file, content } of payload.edits) {
          try {
            const target = resolveWorkspaceEditTarget(workspace, file);
            if (!target) {
              console.warn("Could not resolve edit target inside workspace:", file);
              continue;
            }

            let originalContent = "";
            let fileId = "";
            if (target.kind === "core") {
              originalContent = drafts[target.id] || "";
              fileId = target.id;
            } else if (target.kind === "supplemental") {
              originalContent = supplementalDrafts[target.path] || "";
              fileId = target.path;
            } else {
              originalContent = "";
              fileId = target.name;
            }

            newPending.push({
              id: Math.random().toString(36).substring(7),
              fileId,
              kind: target.kind,
              originalContent,
              newContent: content,
              label: target.label
            });
            applied.push(target.label);
          } catch (err) {
            console.error("Failed to prepare edit for", file, err);
          }
        }
        
        if (newPending.length > 0) {
          setPendingEdits((prev) => [...prev, ...newPending]);
          assistantMessage = stripCuratorEditsBlock(assistantMessage);
          if (!assistantMessage) {
            assistantMessage = `I've proposed changes for ${applied.join(", ")}. Please review and accept them.`;
          } else {
            assistantMessage = assistantMessage + `\n\n_(Proposed changes for: ${applied.join(", ")})_`;
          }
        }
      } else if (payload && chatMode === "ask") {
        assistantMessage =
          `${stripCuratorEditsBlock(assistantMessage)}\n\n_(Ask mode: no file edits were applied.)_`.trim();
      } else if (payload === null && assistantMessage.includes("```curator_edits")) {
        assistantMessage = stripCuratorEditsBlock(assistantMessage) || "I had trouble applying the edits. Please try again.";
      }
      
      setChatMessages((current) => [
        ...current,
        { role: "agent", text: assistantMessage }
      ]);
    } catch (error) {
      console.error("Chat API error:", error);
      setChatMessages((current) => [
        ...current,
        { 
          role: "agent", 
          text: `Error: ${error instanceof Error ? error.message : "Failed to get response. Check your API key and try again."}` 
        }
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const handleChatFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      setChatContextFiles((current) => [...current, ...Array.from(files)]);
    }
    event.target.value = "";
  };

  const removeChatContextFile = (index: number) => {
    setChatContextFiles((current) => current.filter((_, i) => i !== index));
  };

  // Resize handlers
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = document.querySelector(".editor-layout");
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newWidth = ((e.clientX - rect.left) / rect.width) * 100;
      setEditorWidth(Math.min(Math.max(30, newWidth), 85));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const openChatPanel = () => {
    setShowDocxFlow(false);
    setRightPanelOpen(true);
    setRightPanelTab("chat");
  };

  const openSettingsPanel = () => {
    setShowDocxFlow(false);
    setRightPanelOpen(true);
    setRightPanelTab("settings");
  };

  const openCopilotPanel = () => {
    setShowDocxFlow(false);
    setRightPanelOpen(true);
    setRightPanelTab("copilot");
  };

  const parseTasks = (markdown: string) => {
    const lines = markdown.split("\n");
    const tasks: {
      id: string;
      text: string;
      status: "pending" | "running" | "completed";
    }[] = [];
    let counter = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        tasks.push({
          id: `task-${counter++}`,
          text: trimmed.slice(2),
          status: "pending"
        });
      }
    }
    return tasks;
  };

  const runEstimation = () => {
    const tasks = parseTasks(drafts.tasks);
    if (tasks.length === 0) {
      setStatusMessage("No tasks found in tasks.md");
      return;
    }
    setExecutionTasks(tasks);
    setExecutionMode(true);
    setShowWizard(false); // Hide wizard to show execution view
    setRightPanelOpen(false); // Focus on execution
  };

  const startTrainingMode = async () => {
    // Guide Mode: workspace-first onboarding instead of a separate training workspace
    setTrainingOriginalDrafts({ ...drafts });


    setTrainingMode(true);
    setLeftSidebarTab("steps");
    setShowWizard(true);
    if (!workspace) {
      setTrainingStepIndex(1);
      setWizardStep("baseline");
      setNewWorkspaceModalOpen(true);
      setStatusMessage("Create a workspace to get started.");
    } else {
      setTrainingStepIndex(0);
      setWizardStep("baseline");
      setStatusMessage(
        `Guide Mode: "${workspace.name ?? "current workspace"}". Work through each step to build your estimate.`
      );
      openCopilotPanel();
    }
  };

  const navigateToTrainingStep = (step: typeof TRAINING_STEPS[number]) => {
    if (step.highlight === "createWorkspace") {
      setShowWizard(true);
      setWizardStep("baseline");
      setNewWorkspaceModalOpen(true);
      setShowDocxFlow(false);
    } else if (step.highlight === "baseline") {
      setWizardStep("baseline");
      setShowWizard(true);
      setShowDocxFlow(false);
    } else if (step.highlight === "context") {
      setWizardStep("context");
      setShowWizard(true);
      setShowDocxFlow(false);
    } else if (step.highlight === "requirements") {
      setWizardStep("requirements");
      setShowWizard(true);
      setShowDocxFlow(false);
    } else if (step.highlight === "tasks") {
      setWizardStep("tasks");
      setShowWizard(true);
      setShowDocxFlow(false);
    } else if (step.highlight === "estimate" || step.highlight === "export") {
      // Show the cost estimate view for the current workspace
      setShowWizard(false);
      setShowDocxFlow(false);
      openCopilotPanel();
      const costEstimateFile = workspace?.markdownFiles.find(
        (f) => f.name === "cost-estimate.md"
      );
      if (costEstimateFile) {
        openSupplementalFile(costEstimateFile);
      } else {
        setStatusMessage(
          "No estimate draft found yet. Use the Copilot panel to queue a first cost-estimate.md."
        );
      }
    } else if (step.highlight === "chat") {
      setShowWizard(false);
      setShowDocxFlow(false);
      setRightPanelOpen(true);
      setRightPanelTab("chat");
      // Add a demo message to the chat
      setChatMessages((current) => {
        if (current.some((m) => m.text.includes("training demonstration"))) {
          return current;
        }
        return [
          ...current,
          {
            role: "agent" as const,
            text: "Welcome to the chat panel! This is a training demonstration. In a real session, you can ask me to refine your cost estimate, add contingencies, adjust labor rates, or reformat sections. Try typing a question below!"
          }
        ];
      });
    }
  };

  const advanceTrainingStep = () => {
    const nextIndex = trainingStepIndex + 1;
    if (nextIndex >= TRAINING_STEPS.length) {
      exitTrainingMode();
      return;
    }
    setTrainingStepIndex(nextIndex);
    navigateToTrainingStep(TRAINING_STEPS[nextIndex]);
  };

  const previousTrainingStep = () => {
    if (trainingStepIndex > 0) {
      const prevIndex = trainingStepIndex - 1;
      setTrainingStepIndex(prevIndex);
      navigateToTrainingStep(TRAINING_STEPS[prevIndex]);
    }
  };

  const handleTrainingAction = (action: string | null) => {
    if (!action) return;
    if (action === "createWorkspace") {
      setNewWorkspaceModalOpen(true);
      return;
    }
    if (action === "viewEstimate") {
      const costEstimateFile = workspace?.markdownFiles.find(
        (f) => f.name === "cost-estimate.md"
      );
      if (costEstimateFile) {
        openSupplementalFile(costEstimateFile);
      } else {
        setStatusMessage("Cost estimate file not found in workspace.");
      }
    } else if (action === "showExport") {
      setShowDocxFlow(true);
      setShowWizard(false);
    } else if (action === "openChat") {
      setRightPanelOpen(true);
      setRightPanelTab("chat");
    }
  };

  const exitTrainingMode = () => {
    setTrainingMode(false);
    setTrainingStepIndex(0);
    setStatusMessage("Training complete! The workspace is now populated with the example scenario.");
  };

  const restartTraining = () => {
    setTrainingStepIndex(0);
    setWizardStep("baseline");
    setShowWizard(true);
  };

  const currentTrainingStep = trainingMode ? TRAINING_STEPS[trainingStepIndex] : null;

  useEffect(() => {
    if (!executionMode) return;
    let currentTaskIndex = 0;
    
    const interval = setInterval(() => {
      setExecutionTasks((prev) => {
        const next = [...prev];
        
        // Mark previous completed
        if (currentTaskIndex > 0) {
          next[currentTaskIndex - 1].status = "completed";
        }
        
        // Mark current running
        if (currentTaskIndex < next.length) {
          next[currentTaskIndex].status = "running";
        } else {
          // All done
          setExecutionMode(false);
          setRightPanelOpen(true);
          setRightPanelTab("chat");
          setChatMessages((msgs) => [
            ...msgs,
            { role: "agent", text: "Estimation tasks completed. Ready for review." }
          ]);
          clearInterval(interval);
          return next;
        }
        
        return next;
      });
      currentTaskIndex++;
    }, 2000); // Simulate 2s per task

    return () => clearInterval(interval);
  }, [executionMode]);

  const saveSettings = async () => {
    setSettingsStatus("");
    try {
      await window.curator?.configSet({
        provider: settingsProvider,
        model: settingsModel,
        apiKey: settingsApiKey.trim() ? settingsApiKey.trim() : undefined
      });
      setSettingsStatus("Settings saved.");
      if (settingsApiKey.trim()) {
        setSettingsHasKey(true);
        setSettingsKeySuffix(settingsApiKey.slice(-4));
        setSettingsApiKey("");
      }
    } catch (error) {
      setSettingsStatus(
        error instanceof Error ? error.message : "Settings update failed."
      );
    }
  };

  const toggleGuide = (step: WizardStep) => {
    setGuideOpenByStep((current) => ({
      ...current,
      [step]: !current[step]
    }));
  };

  const insertRequirementsSnippet = (
    snippetKey: keyof typeof REQUIREMENTS_SNIPPETS
  ) => {
    const snippet = REQUIREMENTS_SNIPPETS[snippetKey];
    const heading = snippet.split("\n")[0];

    setDrafts((current) => {
      const existing = current.requirements ?? "";
      if (existing.includes(heading)) {
        return current;
      }
      const trimmed = existing.trimEnd();
      return {
        ...current,
        requirements: `${trimmed}${trimmed ? "\n\n" : ""}${snippet}\n`
      };
    });
  };

  const advanceWizard = () => {
    if (wizardStep === "baseline") {
      setWizardStep("context");
    } else if (wizardStep === "context") {
      setWizardStep("requirements");
    } else if (wizardStep === "requirements") {
      setWizardStep("tasks");
    } else if (wizardStep === "tasks") {
      setShowWizard(false);
    }
  };

  const finishWizard = async () => {
    setShowWizard(false);
    setWizardStep("baseline");
    setActiveCoreFile("baseline");
    setShowDocxFlow(true);
    setDocxStatus("");
    setDocxReady(false);
    if (activeWorkspaceId === "default" && !defaultWorkspaceReady) {
      setDefaultWorkspaceReady(true);
      window.curator?.configSet({ defaultWorkspaceReady: true });
    }
    if (!costEstimateFile) {
      await generateEstimateMarkdown();
    }
  };

  const saveNewContextDoc = async () => {
    if (!workspace) return;
    const trimmedName = newContextName.trim();
    if (!trimmedName) {
      setStatusMessage("Name your context document before saving.");
      return;
    }
    setStatusMessage("");
    const permitted = await permissionGate.request({
      resource: "workspace",
      action: "write",
      rationale: "Curator needs to create a reference document.",
      workspacePath: workspaceRoot
    });
    if (!permitted) {
      setPermissionStatus("denied");
      setStatusMessage("Permission denied.");
      return;
    }

    try {
      const saved = await workspaceManager.createContextDocument(
        workspace,
        trimmedName,
        newContextContents
      );
      setWorkspace((current) => {
        if (!current) return current;
        const updated = [...current.contextDocuments, saved].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
        return { ...current, contextDocuments: updated };
      });
      setNewContextName("");
      setNewContextContents("");
      setNewContextOpen(false);
      setPermissionStatus("granted");
      setStatusMessage("Context document saved.");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Save failed."
      );
    }
  };

  useEffect(() => {
    if (!workspace && showWizard && wizardStep !== "baseline") {
      setWizardStep("baseline");
    }
  }, [workspace, showWizard, wizardStep]);

  useEffect(() => {
    if (wizardStep === "baseline") {
      setActiveCoreFile("baseline");
    }
    if (wizardStep === "requirements") {
      setActiveCoreFile("requirements");
    }
    if (wizardStep === "tasks") {
      setActiveCoreFile("tasks");
    }
  }, [wizardStep]);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        if (window.curator?.configGet) {
          const config = await window.curator.configGet();
          if (!cancelled) {
            setSettingsProvider(config.provider || "openrouter");
            setSettingsModel(config.model || "openai/gpt-4o-mini");
            setSettingsHasKey(config.hasApiKey);
            setSettingsKeySuffix(config.apiKeyLast4 || "");
            setDefaultWorkspaceReady(config.defaultWorkspaceReady ?? false);
            setLastOpenedByWorkspace(config.lastOpenedByWorkspace ?? {});
          }
        }
        const listing = await workspaceManager.listWorkspaces();
        if (cancelled) return;
        setWorkspaceRoot(listing.root);
        setWorkspaceList(listing.workspaces);
        const active =
          listing.workspaces.find((ws) => ws.id === listing.activeId) ??
          listing.workspaces[0];
        if (active) {
          await loadWorkspace(active, false, "auto");
        }
      } catch (error) {
        if (cancelled) return;
        setStatusMessage(
          error instanceof Error ? error.message : "Workspace init failed."
        );
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const query = fileSearch.trim();
    if (!workspace || !query) {
      setFileSearchResults([]);
      setFileSearchLoading(false);
      return;
    }
    setFileSearchLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const results = await workspaceManager.searchFiles(workspace, query, 50);
        if (!cancelled) {
          setFileSearchResults(results);
        }
      } catch {
        if (!cancelled) {
          setFileSearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setFileSearchLoading(false);
        }
      }
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [fileSearch, workspace, workspaceManager]);

  const activeExample = baselineGuideOpen
    ? { title: "Baseline examples", markdown: BASELINE_EXAMPLE }
    : requirementsGuideOpen
    ? { title: "Requirements examples", markdown: REQUIREMENTS_EXAMPLE }
    : tasksGuideOpen
    ? { title: "Tasks examples", markdown: TASKS_EXAMPLE }
    : null;
  const examplesOpen = Boolean(activeExample);
  const previewEdit = previewEditId
    ? pendingEdits.find((edit) => edit.id === previewEditId) ?? null
    : null;
  const previewingEdit = Boolean(previewEdit);
  const previewExt = previewEdit ? getFileExtension(previewEdit.label) : "";
  const activeEditorLabel = previewingEdit
    ? `${previewEdit?.label ?? "Proposed update"} (preview)`
    : activeEditor.kind === "core"
    ? `${activeEditor.id}.md`
    : activeEditor.file.name;
  const activeSupplementalPath =
    activeEditor.kind === "supplemental" ? activeEditor.file.path : "";
  const activeSupplementalExt = previewingEdit
    ? previewExt
    : activeEditor.kind === "supplemental"
    ? activeEditor.file.ext
    : "";
  const supplementalDirty =
    !previewingEdit &&
    activeEditor.kind === "supplemental" &&
    supplementalDrafts[activeEditor.file.path] !==
      supplementalOriginals[activeEditor.file.path];
  const editorIsMarkdown = previewingEdit
    ? previewEdit?.kind === "core" ||
      previewExt === ".md" ||
      previewExt === ".markdown"
    : activeEditor.kind === "core"
    ? true
    : activeEditor.isMarkdown;
  const csvPreviewEnabled =
    !previewingEdit &&
    activeEditor.kind === "supplemental" &&
    (activeSupplementalExt === ".csv" ||
      activeSupplementalExt === ".tsv" ||
      activeSupplementalExt === ".xlsx");
  const activeDescription = (() => {
    if (previewingEdit) {
      return "Previewing proposed changes before applying to the workspace.";
    }
    if (activeEditor.kind === "core") {
      return CORE_DESCRIPTIONS[activeEditor.id];
    }
    const path = activeSupplementalPath;
    const isContext =
      path.includes("/context-documents/") ||
      path.includes("\\context-documents\\");
    if (
      activeSupplementalExt === ".csv" ||
      activeSupplementalExt === ".tsv" ||
      activeSupplementalExt === ".xlsx"
    ) {
      return "Spreadsheet data (CSV/TSV/XLSX). Use the table preview for quick scanning.";
    }
    if (activeEditor.isMarkdown) {
      return isContext
        ? "Supporting document with domain knowledge for the estimator."
        : "Text file in the workspace.";
    }
    return isContext
      ? "Supporting document with domain knowledge for the estimator."
      : "Text file in the workspace.";
  })();
  const csvPreviewRows = useMemo(() => {
    if (!csvPreviewEnabled || !csvPreviewOpen) return null;
    const raw = supplementalDrafts[activeSupplementalPath] ?? "";
    const delimiter =
      activeSupplementalExt === ".tsv" || activeSupplementalExt === ".xlsx"
        ? "\t"
        : undefined;
    return parseCsv(raw, delimiter);
  }, [
    csvPreviewEnabled,
    csvPreviewOpen,
    activeSupplementalPath,
    activeSupplementalExt,
    supplementalDrafts
  ]);

  useEffect(() => {
    if (!csvPreviewEnabled) {
      setCsvPreviewOpen(false);
    }
  }, [csvPreviewEnabled, activeSupplementalPath]);

  useEffect(() => {
    if (!selectedTemplatePath && workspace?.templates.length) {
      setSelectedTemplatePath(workspace.templates[0].path);
    }
  }, [selectedTemplatePath, workspace?.templates]);

  useEffect(() => {
    if (!workspace) {
      setCostEstimateFile(null);
      return;
    }
    const existing = workspace.markdownFiles.find(
      (file) => file.name.toLowerCase() === "cost-estimate.md"
    );
    setCostEstimateFile(existing ?? null);
  }, [workspace, workspace?.markdownFiles]);

  useEffect(() => {
    setDocxReady(false);
    setDocxOutputPath("");
  }, [selectedTemplatePath, costEstimateFile]);

  useEffect(() => {
    setAgentRefineActive(rightPanelTab === "chat" && editorIsMarkdown);
  }, [rightPanelTab, editorIsMarkdown]);

  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [chatMessages, chatLoading, rightPanelTab]);

  const copilotModel = useMemo(() =>
    buildEstimateCopilotModel({
      workspace,
      baseline: drafts.baseline,
      requirements: drafts.requirements,
      tasks: drafts.tasks
    }),
    [workspace, drafts.baseline, drafts.requirements, drafts.tasks]
  );

  const activeScenario = copilotModel.scenarios[copilotScenario];
  const fallbackInsights = useMemo<InsightPayload>(
    () => ({
      summary: copilotModel.executiveSummary,
      rangeLow: activeScenario.low,
      rangeHigh: activeScenario.high,
      confidence: activeScenario.confidence,
      confidenceLabel: copilotModel.confidenceLabel,
      scenarioLabel: activeScenario.label,
      scenarioNarrative: activeScenario.narrative,
      drivers: copilotModel.drivers.map((driver) => ({
        label: driver.label,
        category: driver.category || "General",
        impact: driver.impact,
        description: driver.description,
        sources: driver.sources
      })),
      savings: copilotModel.savings.map((saving) => ({
        label: saving.label,
        category: saving.category || "General",
        impact: saving.impact,
        description: saving.description,
        sources: saving.sources
      }))
    }),
    [activeScenario, copilotModel]
  );
  const insightsData = aiInsights ?? fallbackInsights;
  const driverGroups = useMemo(
    () => groupInsights(insightsData.drivers),
    [insightsData.drivers]
  );
  const savingsGroups = useMemo(
    () => groupInsights(insightsData.savings),
    [insightsData.savings]
  );
  const insightsAvailable = Boolean(costEstimateFile);

  return (
    <div className="app">
      <div className="menu-bar">
        <div className="menu-brand">Curator</div>
        <LiveSyncIndicator />
        <div className="menu-actions">
          <button 
            className={`ghost menu-btn-with-icon menu-icon-btn ${trainingMode ? "training-active" : ""}`} 
            onClick={startTrainingMode}
            data-tooltip="Interactive tutorial: Walk through a complete AI/ML cost estimation with pre-filled examples"
            aria-label={trainingMode ? "In Training" : "Training"}
          >
            <svg className="menu-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
              <path d="M6 12v5c3 3 9 3 12 0v-5"/>
            </svg>
          </button>
          <button 
            className="ghost menu-btn-with-icon menu-icon-btn" 
            onClick={openChatPanel}
            data-tooltip="Open the AI assistant to refine estimates, ask questions, or get suggestions"
            aria-label="Chat"
          >
            <svg className="menu-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button 
            className="ghost menu-btn-with-icon menu-icon-btn" 
            onClick={openSettingsPanel}
            data-tooltip="Configure AI provider, API keys, and application preferences"
            aria-label="Settings"
          >
            <svg className="menu-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <button
            className="ghost menu-icon-btn"
            onClick={() => window.curator?.closeWindow?.()}
            data-tooltip="Close this window (app keeps running)"
            aria-label="Close window"
          >
            <svg className="menu-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <button
            className="ghost menu-icon-btn"
            onClick={() => window.curator?.quitApp?.()}
            data-tooltip="Quit Curator completely"
            aria-label="Exit application"
          >
            <svg className="menu-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
              <line x1="12" y1="2" x2="12" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      <main className={`workspace-layout ${leftSidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <aside className={`panel sidebar ${leftSidebarCollapsed ? "collapsed" : ""}`}>
          {leftSidebarCollapsed ? (
            <div className="sidebar-collapsed-content">
              <button
                className="sidebar-icon-btn"
                onClick={() => setLeftSidebarCollapsed(false)}
                data-tooltip="Expand sidebar"
              >
                <svg className="sidebar-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                  <path d="M13 12h4" />
                  <path d="M15 10l2 2-2 2" />
                </svg>
              </button>
            </div>
          ) : (
          <>
          <div className="sidebar-header">
            <div className="sidebar-tabs">
              <button
                type="button"
                className={`sidebar-tab ${leftSidebarTab === "workspaces" ? "active" : ""}`}
                onClick={() => setLeftSidebarTab("workspaces")}
                title="Explorer"
              >
                <svg className="sidebar-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span className="sidebar-tab-text">Explorer</span>
              </button>
              <button
                type="button"
                className="sidebar-tab sidebar-tab--add"
                onClick={(e) => { e.stopPropagation(); addWorkspace(); }}
                data-tooltip="Add or open workspace"
              >
                <svg className="sidebar-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                className={`sidebar-tab ${leftSidebarTab === "steps" ? "active" : ""}`}
                onClick={() => setLeftSidebarTab("steps")}
                title="Steps"
              >
                <svg className="sidebar-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                <span className="sidebar-tab-text">Steps</span>
              </button>
            </div>
          </div>

          {leftSidebarTab === "workspaces" ? (
            <div className="workspace-tree">
              <div className="sidebar-toolbar">
                <div className="sidebar-toolbar-actions">
                  <button
                    type="button"
                    className="sidebar-toolbar-icon"
                    onClick={copyWorkspacePath}
                    data-tooltip="Copy workspace path"
                    disabled={!workspaceRoot}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="sidebar-toolbar-icon"
                    onClick={refreshActiveWorkspace}
                    data-tooltip="Refresh"
                    disabled={openingWorkspace || contextImporting || !activeWorkspaceId}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                      <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="sidebar-toolbar-icon"
                    onClick={() => { setCoreOpen((o) => !o); setContextOpen((o) => !o); setTemplatesOpen((o) => !o); }}
                    data-tooltip="Toggle folders"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      {coreOpen && contextOpen && templatesOpen ? <polyline points="6 9 12 15 18 9" /> : <polyline points="9 6 15 12 9 18" />}
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="sidebar-toolbar-icon"
                    onClick={() => setLeftSidebarCollapsed(true)}
                    data-tooltip="Close sidebar"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="workspace-list">
                {workspaceList.map((entry) => {
                    const isActive = entry.id === activeWorkspaceId;
                    return (
                      <div key={entry.id} className="workspace-node">
                        <button
                          className={`workspace-button ${
                            isActive ? "active" : ""
                          }`}
                          onClick={() => loadWorkspace(entry, true, "switch")}
                        >
                          {entry.name}
                        </button>
                        {isActive ? (
                          <div className="workspace-children">
                            {workspace?.missing.length ? (
                              <div className="field">
                                <label>Missing files</label>
                                <span>{workspace.missing.join(", ")}</span>
                                <div className="action-row">
                                  <button 
                                    onClick={createMissingFiles}
                                    data-tooltip="Create empty versions of required workspace files (baseline.md, requirements.md, tasks.md)"
                                  >
                                    Create Missing
                                  </button>
                                </div>
                              </div>
                            ) : null}

                            <div className="file-search">
                              <div className="file-search-bar">
                                <button
                                  type="button"
                                  className="file-search-icon"
                                  onClick={() => fileSearchInputRef.current?.focus()}
                                  data-tooltip="Search files"
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="11" cy="11" r="8" />
                                    <path d="m21 21-4.35-4.35" />
                                  </svg>
                                </button>
                                <input
                                  ref={fileSearchInputRef}
                                  className="file-search-input"
                                  placeholder="Search files..."
                                  value={fileSearch}
                                  onChange={(e) => setFileSearch(e.target.value)}
                                  type="text"
                                />
                                {fileSearch ? (
                                  <button
                                    className="file-search-clear"
                                    onClick={() => {
                                      setFileSearch("");
                                      setFileSearchResults([]);
                                    }}
                                    aria-label="Clear search"
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <line x1="18" y1="6" x2="6" y2="18" />
                                      <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                  </button>
                                ) : null}
                              </div>
                              {fileSearch ? (
                                <div className="file-search-results">
                                  {fileSearchLoading ? (
                                    <div className="file-search-status">Searching…</div>
                                  ) : fileSearchResults.length ? (
                                    fileSearchResults.map((result) => (
                                      <button
                                        key={result.path}
                                        className="file-search-row"
                                        onClick={() => openSearchResult(result)}
                                      >
                                        <div className="file-search-name">{result.name}</div>
                                        {result.snippet ? (
                                          <div className="file-search-snippet">
                                            {renderSnippet(result.snippet)}
                                          </div>
                                        ) : null}
                                        <div className="file-search-path">
                                          {result.path}
                                        </div>
                                      </button>
                                    ))
                                  ) : (
                                    <div className="file-search-status">
                                      No matches for "{fileSearch.trim()}"
                                    </div>
                                  )}
                                </div>
                              ) : null}
                            </div>

                            <div className="file-tree">
                              <div className="tree-section">
                                <button
                                  className="tree-section-header"
                                  onClick={() => setCoreOpen((prev) => !prev)}
                                >
                                  <svg className="tree-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    {coreOpen ? <polyline points="6 9 12 15 18 9" /> : <polyline points="9 6 15 12 9 18" />}
                                  </svg>
                                  <span>Core files</span>
                                </button>
                                {coreOpen && (
                                  <div className="tree-section-children">
                                    {WORKSPACE_FILE_ORDER.map((id) => {
                                      const isSelected = activeEditor.kind === "core" && activeEditor.id === id;
                                      return (
                                        <button
                                          key={id}
                                          className={`tree-file-row ${isSelected ? "tree-file-row--selected" : ""}`}
                                          onClick={() => handleSwitchFile(id)}
                                        >
                                          <svg className="tree-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                            <polyline points="14 2 14 8 20 8" />
                                          </svg>
                                          <span className="tree-file-name">{id}.md</span>
                                          {workspace?.missing.includes(id) && (
                                            <span className="tree-badge tree-badge--missing">missing</span>
                                          )}
                                          {workspace && isDirty(id) && (
                                            <span className="tree-badge tree-badge--unsaved">unsaved</span>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>

                              <div className="tree-section">
                                <div className="tree-section-header-row">
                                  <button
                                    className="tree-section-header"
                                    onClick={() => setContextOpen((prev) => !prev)}
                                  >
                                    <svg className="tree-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      {contextOpen ? <polyline points="6 9 12 15 18 9" /> : <polyline points="9 6 15 12 9 18" />}
                                    </svg>
                                    <span>Supporting documents</span>
                                  </button>
                                  <button
                                    className="tree-section-action"
                                    onClick={startContextUpload}
                                    data-tooltip="Import reference files (rate cards, prior estimates, architecture docs)"
                                    disabled={contextImporting}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <line x1="12" y1="5" x2="12" y2="19" />
                                      <line x1="5" y1="12" x2="19" y2="12" />
                                    </svg>
                                  </button>
                                  <button
                                    className="tree-section-action"
                                    onClick={refreshActiveWorkspace}
                                    data-tooltip="Refresh supporting documents"
                                    disabled={openingWorkspace || contextImporting}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="23 4 23 10 17 10" />
                                      <polyline points="1 20 1 14 7 14" />
                                      <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
                                      <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
                                    </svg>
                                  </button>
                                </div>
                                {contextOpen && (
                                  <div className="tree-section-children">
                                    {contextImporting ? (
                                      <div className="tree-inline-status">
                                        Importing supporting documents and converting them to markdown…
                                      </div>
                                    ) : null}
                                    <div
                                      className={`tree-drop-area ${contextDragActive ? "tree-drop-area--active" : ""}`}
                                      onDragOver={(e) => { e.preventDefault(); setContextDragActive(true); }}
                                      onDragLeave={() => setContextDragActive(false)}
                                      onDrop={(e) => handleDrop(e, "context")}
                                    >
                                      Drop files here
                                    </div>
                                    {workspace?.contextDocuments.length ? (
                                      workspace.contextDocuments.map((file) => {
                                        const isSelected = activeEditor.kind === "supplemental" && activeEditor.file.path === file.path;
                                        return (
                                          <button
                                            key={file.path}
                                            className={`tree-file-row ${isSelected ? "tree-file-row--selected" : ""}`}
                                            onClick={() => openSupplementalFile(file)}
                                          >
                                            <svg className="tree-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                              <polyline points="14 2 14 8 20 8" />
                                            </svg>
                                            <span className="tree-file-name">{file.name}</span>
                                          </button>
                                        );
                                      })
                                    ) : (
                                      <div className="tree-empty-hint">No documents yet</div>
                                    )}
                                    {workspace?.markdownFiles.length ? (
                                      workspace.markdownFiles.map((file) => {
                                        const isSelected = activeEditor.kind === "supplemental" && activeEditor.file.path === file.path;
                                        return (
                                          <button
                                            key={file.path}
                                            className={`tree-file-row ${isSelected ? "tree-file-row--selected" : ""}`}
                                            onClick={() => openSupplementalFile(file)}
                                          >
                                            <svg className="tree-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                              <polyline points="14 2 14 8 20 8" />
                                            </svg>
                                            <span className="tree-file-name">{file.name}</span>
                                          </button>
                                        );
                                      })
                                    ) : null}
                                  </div>
                                )}
                              </div>

                              <div className="tree-section">
                                <button
                                  className="tree-section-header"
                                  onClick={() => setTemplatesOpen((prev) => !prev)}
                                >
                                  <svg className="tree-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    {templatesOpen ? <polyline points="6 9 12 15 18 9" /> : <polyline points="9 6 15 12 9 18" />}
                                  </svg>
                                  <span>Export templates</span>
                                </button>
                                {templatesOpen && (
                                  <div className="tree-section-children">
                                    <div
                                      className={`tree-drop-area ${templateDragActive ? "tree-drop-area--active" : ""}`}
                                      onDragOver={(e) => { e.preventDefault(); setTemplateDragActive(true); }}
                                      onDragLeave={() => setTemplateDragActive(false)}
                                      onDrop={(e) => handleDrop(e, "template")}
                                    >
                                      Drop .docx templates
                                    </div>
                                    {workspace?.templates.length ? (
                                      workspace.templates.map((file) => (
                                        <div key={file.path} className="tree-file-row">
                                          <svg className="tree-file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                            <polyline points="14 2 14 8 20 8" />
                                          </svg>
                                          <span className="tree-file-name">{file.name}</span>
                                        </div>
                                      ))
                                    ) : (
                                      <div className="tree-empty-hint">No templates yet</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="steps-sidebar">
              <div className="steps-header">
                <h3>Setup steps</h3>
                <p>Move between baseline, requirements, tasks, and context.</p>
              </div>
              <div className="steps-list">
                {WIZARD_STEPS.map((step, index) => (
                  <button
                    key={step.id}
                    className={`steps-row ${
                      wizardStep === step.id ? "active" : ""
                    }`}
                    onClick={() => {
                      setShowWizard(true);
                      setWizardStep(step.id);
                    }}
                  >
                    <span className="steps-index">{index + 1}</span>
                    <div className="steps-text">
                      <span className="steps-title">{step.label}</span>
                      <span className="steps-subtitle">
                        {STEP_DESCRIPTIONS[step.id]}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {statusMessage ? (
            <div className="sidebar-status">
              <div className="sidebar-status-row">
                <label>Status</label>
                <span>{statusMessage}</span>
              </div>
            </div>
          ) : null}
          </>
          )}
          {!leftSidebarCollapsed && (
            <div className="sidebar-footer">
               <button
                className="sidebar-footer-btn"
                onClick={startTrainingMode}
                data-tooltip="Walk through creating a workspace and generating your first estimate"
              >
                <svg className="sidebar-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 16v-4"/>
                  <path d="M12 8h.01"/>
                </svg>
                Guide Mode
              </button>
            </div>
          )}
        </aside>

        <section className="panel editor-panel">
          {showDocxFlow ? (
            <div className="docx-flow">
              <div className="setup-panel">
                <div className="setup-header">
                  <div>
                    <h2>Generate DOCX</h2>
                    <p>
                      Choose a template, generate your cost estimate draft,
                      and create a DOCX you can open in Word or Pages.
                    </p>
                  </div>
                </div>

                <div className="setup-content">
                  <div className="setup-card">
                    <h3>Cost estimate draft</h3>
                    <p>
                      Review or edit your estimate before generating the final
                      DOCX.
                    </p>
                    <div className="setup-actions">
                      {costEstimateFile ? (
                        <>
                          <button
                            onClick={() => openSupplementalFile(costEstimateFile)}
                          >
                            Open {costEstimateFile.name}
                          </button>
                          <span className="muted">
                            Ready to export.
                          </span>
                        </>
                      ) : (
                        <button onClick={generateEstimateMarkdown}>
                          Create cost-estimate.md
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="setup-card">
                    <h3>Select a template</h3>
                    <p>Pick one template to generate the DOCX output.</p>
                    <div className="template-list">
                      {workspace?.templates.length ? (
                        workspace.templates.map((template) => (
                          <button
                            key={template.path}
                            className={`template-item ${
                              template.path === selectedTemplatePath
                                ? "active"
                                : ""
                            }`}
                            onClick={() =>
                              setSelectedTemplatePath(template.path)
                            }
                          >
                            {template.name}
                          </button>
                        ))
                      ) : (
                        <p className="muted">No templates uploaded yet.</p>
                      )}
                    </div>
                    <div className="setup-actions">
                      <button onClick={startTemplateUpload}>
                        Upload template
                      </button>
                    </div>
                  </div>

                  <div className="setup-card">
                    <h3>Generate DOCX output</h3>
                    <p>
                      Uses your selected template to generate a DOCX file in
                      the workspace.
                    </p>
                    <div className="setup-actions">
                      <button
                        onClick={generateDocx}
                        disabled={!selectedTemplatePath || !costEstimateFile}
                      >
                        Generate DOCX
                      </button>
                      {docxReady ? (
                        <button className="ghost" onClick={openDocx}>
                          Open DOCX
                        </button>
                      ) : null}
                    </div>
                    {docxStatus ? (
                      <p className="muted">{docxStatus}</p>
                    ) : null}
                  </div>

                  {docxReady ? (
                    <div className="setup-card">
                      <h3>Refine with the copilot</h3>
                      <p>
                        Chat with the copilot to refine your estimate or any
                        other workspace file.
                      </p>
                      <div className="setup-actions">
                        <button onClick={startChatRefinement}>
                          Open chat
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : showWizard ? (
            <div className={`wizard-layout ${examplesOpen && examplesDocked ? "wizard-layout--docked" : ""}`}>
              <div className="wizard-main">
                <div className="setup-panel">
                  <div className="setup-content">
                    {wizardStep === "baseline" ? (
                      <div className="setup-card">
                        <div className="card-header-collapsible">
                          <div>
                            <h3>Establish the baseline</h3>
                            <button
                              className="collapse-toggle"
                              onClick={() => toggleGuide("baseline")}
                              aria-label={
                                guideOpenByStep.baseline
                                  ? "Collapse baseline guide"
                                  : "Expand baseline guide"
                              }
                            >
                              {guideOpenByStep.baseline ? "▼" : "▶"}
                            </button>
                          </div>
                          {guideOpenByStep.baseline && (
                            <>
                              <p>
                                The baseline anchors every estimate. Answer these to get started:
                              </p>
                              <ul className="guide-questions">
                                <li>What is this engagement about? (1–2 sentences.)</li>
                                <li>Which systems, modules, or workstreams are in scope?</li>
                                <li>What is explicitly out of scope?</li>
                                <li>What assumptions are you making (access, data, timeline)?</li>
                              </ul>
                            </>
                          )}
                        </div>
                        <button
                          className="link-button"
                          onClick={() => {
                            setBaselineGuideOpen((prev) => !prev);
                            setRequirementsGuideOpen(false);
                            setTasksGuideOpen(false);
                          }}
                        >
                          {baselineGuideOpen
                            ? "Hide examples"
                            : "View examples"}
                        </button>
                        <MarkdownEditor
                          markdown={drafts.baseline}
                          onChange={(value) =>
                            setDrafts((current) => ({
                              ...current,
                              baseline: value
                            }))
                          }
                          readOnly={false}
                          placeholder="Describe the engagement, scope, and assumptions..."
                        />
                        <div className="setup-actions">
                          <button 
                            className="setup-btn setup-btn--secondary"
                            onClick={() => saveFile("baseline")}
                            data-tooltip="Save your baseline document to the workspace folder"
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                              <polyline points="17 21 17 13 7 13 7 21"/>
                              <polyline points="7 3 7 8 15 8"/>
                            </svg>
                            Save baseline
                          </button>
                          <button 
                            className="setup-btn setup-btn--primary"
                            onClick={advanceWizard}
                            data-tooltip="Continue to upload context documents that inform the estimate"
                          >
                            Next: Context
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="9 18 15 12 9 6"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {wizardStep === "requirements" ? (
                      <div className="setup-card">
                        <div className="card-header-collapsible">
                          <div>
                            <h3>Define the requirements</h3>
                            <button
                              className="collapse-toggle"
                              onClick={() => toggleGuide("requirements")}
                              aria-label={
                                guideOpenByStep.requirements
                                  ? "Collapse requirements guide"
                                  : "Expand requirements guide"
                              }
                            >
                              {guideOpenByStep.requirements ? "▼" : "▶"}
                            </button>
                          </div>
                          {guideOpenByStep.requirements && (
                            <>
                              <p>
                                Turn discovery into a pricing-ready brief. Consider:
                              </p>
                              <ul className="guide-questions">
                                <li>What are the main goals and success criteria?</li>
                                <li>What are the timeline and budget guardrails?</li>
                                <li>What must be true for stakeholders to sign off?</li>
                                <li>What pricing inputs (rates, effort, non-labor) matter?</li>
                              </ul>
                            </>
                          )}
                        </div>
                        <div className="requirements-quick-actions">
                          <span className="muted">
                            Start fast with structured sections
                          </span>
                          <div className="chip-row">
                            <button
                              className="chip-button"
                              onClick={() => insertRequirementsSnippet("goals")}
                              data-tooltip="Add a goals section with placeholders for objectives, success metrics, and KPIs"
                            >
                              + Goals
                            </button>
                            <button
                              className="chip-button"
                              onClick={() =>
                                insertRequirementsSnippet("constraints")
                              }
                              data-tooltip="Add constraints section for budget limits, timeline restrictions, and technical boundaries"
                            >
                              + Constraints
                            </button>
                            <button
                              className="chip-button"
                              onClick={() =>
                                insertRequirementsSnippet("acceptance")
                              }
                              data-tooltip="Add acceptance criteria section for sign-off requirements and deliverable standards"
                            >
                              + Acceptance Criteria
                            </button>
                            <button
                              className="chip-button"
                              onClick={() => insertRequirementsSnippet("pricing")}
                              data-tooltip="Add pricing inputs section for labor rates, infrastructure costs, and non-labor expenses"
                            >
                              + Pricing Inputs
                            </button>
                          </div>
                        </div>
                        <button
                          className="link-button"
                          onClick={() => {
                            setRequirementsGuideOpen((prev) => !prev);
                            setBaselineGuideOpen(false);
                            setTasksGuideOpen(false);
                          }}
                        >
                          {requirementsGuideOpen
                            ? "Hide examples"
                            : "View examples"}
                        </button>
                        <MarkdownEditor
                          markdown={drafts.requirements}
                          onChange={(value) =>
                            setDrafts((current) => ({
                              ...current,
                              requirements: value
                            }))
                          }
                          readOnly={false}
                          placeholder="Describe goals, constraints, and success criteria..."
                        />
                        <div className="setup-actions">
                          <button 
                            className="setup-btn setup-btn--secondary"
                            onClick={() => saveFile("requirements")}
                            data-tooltip="Save your requirements document to the workspace folder"
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                              <polyline points="17 21 17 13 7 13 7 21"/>
                              <polyline points="7 3 7 8 15 8"/>
                            </svg>
                            Save requirements
                          </button>
                          <button 
                            className="setup-btn setup-btn--primary"
                            onClick={advanceWizard}
                            data-tooltip="Continue to define the task sequence for the estimator"
                          >
                            Next: Tasks
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="9 18 15 12 9 6"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {wizardStep === "context" ? (
                      <div className="setup-card">
                        <div className="card-header-collapsible">
                          <div>
                            <h3>Upload context documents</h3>
                            <button
                              className="collapse-toggle"
                              onClick={() => toggleGuide("context")}
                              aria-label={
                                guideOpenByStep.context
                                  ? "Collapse context guide"
                                  : "Expand context guide"
                              }
                            >
                              {guideOpenByStep.context ? "▼" : "▶"}
                            </button>
                          </div>
                          {guideOpenByStep.context && (
                            <p>
                              Supporting documents help the copilot become both a
                              business and technical subject-matter expert. The
                              richer the context, the more accurate the estimate.
                            </p>
                          )}
                        </div>
                        <div className="setup-actions">
                          <button 
                            className="setup-btn setup-btn--secondary"
                            onClick={startContextUpload}
                            data-tooltip="Select files from your computer to add as context documents"
                            disabled={contextImporting}
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                              <polyline points="17 8 12 3 7 8"/>
                              <line x1="12" y1="3" x2="12" y2="15"/>
                            </svg>
                            {contextImporting ? "Importing…" : "Upload files"}
                          </button>
                          <button
                            className="setup-btn setup-btn--secondary"
                            onClick={refreshActiveWorkspace}
                            data-tooltip="Refresh supporting documents from disk"
                            disabled={openingWorkspace || contextImporting}
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="23 4 23 10 17 10" />
                              <polyline points="1 20 1 14 7 14" />
                              <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
                              <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
                            </svg>
                            Refresh files
                          </button>
                          <button
                            className="setup-btn setup-btn--secondary"
                            onClick={() => setNewContextOpen((prev) => !prev)}
                            data-tooltip="Create a new context document by writing directly in the editor"
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 5v14M5 12h14"/>
                            </svg>
                            {newContextOpen ? "Hide editor" : "New document"}
                          </button>
                          <button 
                            className="setup-btn setup-btn--primary"
                            onClick={advanceWizard}
                            data-tooltip="Continue to define requirements and success criteria"
                          >
                            Next: Requirements
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="9 18 15 12 9 6"/>
                            </svg>
                          </button>
                        </div>
                        <div
                          className={`dropzone ${
                            contextDragActive ? "dropzone--active" : ""
                          }`}
                          onDragOver={(event) => {
                            event.preventDefault();
                            setContextDragActive(true);
                          }}
                          onDragLeave={() => setContextDragActive(false)}
                          onDrop={(event) => handleDrop(event, "context")}
                        >
                          Drag & drop .txt, .md, .json, .yaml, spreadsheets,
                          and other supporting files
                        </div>
                        {contextImporting ? (
                          <p className="context-import-status">
                            Importing supporting documents and converting them to markdown…
                          </p>
                        ) : null}
                        {workspace?.contextDocuments.length ? (
                          <ul className="file-list">
                            {workspace.contextDocuments.map((file) => (
                              <li key={file.path}>{file.name}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="muted">No context documents yet.</p>
                        )}
                        {newContextOpen ? (
                          <div className="context-editor">
                            <label>Context document name</label>
                            <input
                              className="text-input"
                              value={newContextName}
                              onChange={(event) =>
                                setNewContextName(event.target.value)
                              }
                              placeholder="customer-overview.md"
                            />
                            <MarkdownEditor
                              markdown={newContextContents}
                              onChange={setNewContextContents}
                              readOnly={false}
                              placeholder="Write the context document..."
                            />
                            <div className="setup-actions">
                              <button onClick={saveNewContextDoc}>
                                Save context document
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {wizardStep === "tasks" ? (
                  <div className="setup-card">
                    <div className="card-header-collapsible">
                      <div>
                        <h3>Define the task sequence</h3>
                        <button
                          className="collapse-toggle"
                          onClick={() => toggleGuide("tasks")}
                          aria-label={
                            guideOpenByStep.tasks
                              ? "Collapse tasks guide"
                              : "Expand tasks guide"
                          }
                        >
                          {guideOpenByStep.tasks ? "▼" : "▶"}
                        </button>
                      </div>
                      {guideOpenByStep.tasks && (
                        <>
                          <p>
                            The <strong>Tasks</strong> file tells the estimator what to do, in order. You can reference supporting documents here.
                          </p>
                          <ul className="guide-questions">
                            <li>What should the estimator review first? (e.g. baseline, requirements, supporting docs)</li>
                            <li>What analysis or outputs should it produce?</li>
                            <li>What review or summarization steps are needed?</li>
                            <li>How should it refine based on feedback?</li>
                          </ul>
                        </>
                      )}
                    </div>
                    <div className="button-row" style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                      <button
                        className="link-button"
                        onClick={() => {
                          setTasksGuideOpen((prev) => !prev);
                          setBaselineGuideOpen(false);
                          setRequirementsGuideOpen(false);
                        }}
                      >
                        {tasksGuideOpen ? "Hide examples" : "View examples"}
                      </button>
                      <button 
                        className="primary-button"
                        onClick={runEstimation}
                        style={{ marginLeft: 'auto', background: '#0f1115', color: 'white', border: 'none' }}
                      >
                        Run Estimation
                      </button>
                    </div>
                    <MarkdownEditor
                          markdown={drafts.tasks}
                          onChange={(value) =>
                            setDrafts((current) => ({
                              ...current,
                              tasks: value
                            }))
                          }
                          readOnly={false}
                          placeholder="List tasks in order..."
                        />
                        <div className="setup-actions">
                          <button 
                            className="setup-btn setup-btn--secondary"
                            onClick={() => saveFile("tasks")}
                            data-tooltip="Save your task definitions to the workspace folder"
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                              <polyline points="17 21 17 13 7 13 7 21"/>
                              <polyline points="7 3 7 8 15 8"/>
                            </svg>
                            Save tasks
                          </button>
                          <button 
                            className="setup-btn setup-btn--primary"
                            onClick={finishWizard}
                            data-tooltip="Complete setup and run the estimator to generate cost estimates"
                          >
                            <svg className="setup-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polygon points="5 3 19 12 5 21 5 3"/>
                            </svg>
                            Run Estimation
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {examplesOpen && activeExample && !examplesDocked ? (
                <div className="modal-overlay" onClick={() => {
                  setBaselineGuideOpen(false);
                  setRequirementsGuideOpen(false);
                  setTasksGuideOpen(false);
                }}>
                  <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
                    <div className="modal-header">
                      <h3>{activeExample.title}</h3>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button 
                          className="ghost"
                          onClick={() => setExamplesDocked(true)}
                          title="Dock to side"
                          style={{ padding: '4px 8px', fontSize: '16px' }}
                        >
                          ◫
                        </button>
                        <button
                          className="modal-close"
                          onClick={() => {
                            setBaselineGuideOpen(false);
                            setRequirementsGuideOpen(false);
                            setTasksGuideOpen(false);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    <div className="modal-content">
                      <div
                        className="markdown-preview is-active"
                        dangerouslySetInnerHTML={{
                          __html: editorController.markdownToHtml(
                            activeExample.markdown
                          )
                        }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
              {examplesOpen && activeExample && examplesDocked ? (
                <aside className="examples-docked" style={{ 
                  width: '320px', 
                  borderLeft: '1px solid #e5e7eb', 
                  background: 'white', 
                  display: 'flex', 
                  flexDirection: 'column',
                  height: '100%',
                  overflow: 'hidden'
                }}>
                  <div className="docked-header" style={{ 
                    padding: '16px', 
                    borderBottom: '1px solid #e5e7eb', 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center' 
                  }}>
                    <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{activeExample.title}</h3>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button 
                        className="ghost"
                        onClick={() => setExamplesDocked(false)}
                        title="Undock to modal"
                        style={{ padding: '4px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px' }}
                      >
                        ⧉
                      </button>
                      <button
                        className="ghost"
                        onClick={() => {
                          setBaselineGuideOpen(false);
                          setRequirementsGuideOpen(false);
                          setTasksGuideOpen(false);
                        }}
                        style={{ padding: '4px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <div className="docked-content" style={{ padding: '16px', overflowY: 'auto', flex: 1 }}>
                    <div
                      className="markdown-preview is-active"
                      dangerouslySetInnerHTML={{
                        __html: editorController.markdownToHtml(
                          activeExample.markdown
                        )
                      }}
                    />
                  </div>
                </aside>
              ) : null}
            </div>
          ) : executionMode ? (
            <div className="execution-layout">
              <div className="execution-panel">
                <div className="execution-header">
                  <h2>Running Estimation</h2>
                  <p>Copilot is processing your tasks to build the estimate...</p>
                </div>
                <div className="task-list">
                  {executionTasks.map((task) => (
                    <div key={task.id} className={`task-item task-item--${task.status}`}>
                      <div className="task-status-icon">
                        {task.status === "completed" ? "✓" : task.status === "running" ? "⟳" : "○"}
                      </div>
                      <span className="task-text">{task.text}</span>
                    </div>
                  ))}
                </div>
                <div className="execution-actions">
                  <button onClick={() => setExecutionMode(false)}>Cancel</button>
                </div>
              </div>
            </div>
          ) : (
            <div
              className={`editor-layout ${
                rightPanelOpen ? "editor-layout--split" : ""
              } ${examplesOpen && examplesDocked ? "editor-layout--docked" : ""} ${isResizing ? "editor-layout--resizing" : ""}`}
              style={rightPanelOpen ? { "--editor-width": `${editorWidth}%` } as React.CSSProperties : undefined}
            >
              <div className="editor-main">
                <div className="editor-header">
                  <div>
                    <h2>{activeEditorLabel}</h2>
                    <p>{activeDescription}</p>
                    <p className="editor-hint">
                      {editorIsMarkdown
                        ? "Paste CSV or TSV to auto-create tables."
                        : "Editing plain text."}
                    </p>
                  </div>
                <div className="editor-actions">
                  {previewingEdit ? (
                    <>
                      <button onClick={() => previewEdit && acceptEdit(previewEdit)}>
                        Apply changes
                      </button>
                      <button
                        className="ghost"
                        onClick={() => previewEdit && rejectEdit(previewEdit)}
                      >
                        Discard
                      </button>
                      <button className="ghost" onClick={() => setPreviewEditId(null)}>
                        Exit preview
                      </button>
                    </>
                  ) : (
                    <>
                  {csvPreviewEnabled ? (
                    <button
                      className="ghost"
                      onClick={() => setCsvPreviewOpen((prev) => !prev)}
                    >
                      {csvPreviewOpen ? "Hide table" : "View table"}
                    </button>
                  ) : null}
                  {!rightPanelOpen ? (
                    <button
                      className="ghost"
                      onClick={() => setRightPanelOpen(true)}
                    >
                      Show panel
                    </button>
                  ) : null}
                  <button
                    onClick={() =>
                      activeEditor.kind === "core"
                        ? saveFile(activeEditor.id)
                        : saveSupplementalFile(activeEditor.file)
                    }
                    disabled={
                      !workspace ||
                      (activeEditor.kind === "core"
                        ? !isDirty(activeEditor.id)
                        : !supplementalDirty)
                    }
                  >
                    Save
                  </button>
                    </>
                  )}
                </div>
              </div>
                <div className="main-tabs">
                  <div className="main-tab-buttons">
                    <button
                      className={`main-tab ${mainTab === "editor" ? "main-tab--active" : ""}`}
                      onClick={() => setMainTab("editor")}
                    >
                      Editor
                    </button>
                    <button
                      className={`main-tab ${mainTab === "insights" ? "main-tab--active" : ""}`}
                      onClick={() => setMainTab("insights")}
                      disabled={!insightsAvailable}
                    >
                      Cost insights
                    </button>
                  </div>
                  <div className="main-tab-actions">
                    <button
                      className="ghost"
                      onClick={regenerateCostEstimate}
                      disabled={!workspace || insightsLoading}
                    >
                      {insightsAvailable ? "Regenerate cost estimate" : "Generate cost estimate"}
                    </button>
                    {insightsStatus ? (
                      <span className="muted">{insightsStatus}</span>
                    ) : null}
                  </div>
                </div>

                {mainTab === "insights" ? (
                  <section className="insights-panel">
                    {!insightsAvailable ? (
                      <div className="insights-empty">
                        Generate a cost estimate to unlock insights.
                      </div>
                    ) : (
                      <>
                        <div className="insights-header">
                          <div>
                            <span className="insights-kicker">Cost Insights</span>
                            <h3>Drivers and savings levers</h3>
                            <p className="muted">
                              Insights refresh when you regenerate the estimate after edits.
                            </p>
                          </div>
                          <div className="insights-actions">
                            <button className="ghost" onClick={openChatPanel}>
                              Refine with chat
                            </button>
                          </div>
                        </div>

                        <div className="insights-kpis">
                          <div className="insights-kpi">
                            <span className="insights-kpi-label">Recommended range</span>
                            <strong>
                              {formatCurrency(insightsData.rangeLow)} –{" "}
                              {formatCurrency(insightsData.rangeHigh)}
                            </strong>
                            <span className="insights-kpi-subtitle">
                              {insightsData.confidenceLabel} ({insightsData.confidence}%)
                            </span>
                          </div>
                          <div className="insights-kpi">
                            <span className="insights-kpi-label">Scenario</span>
                            <strong>{insightsData.scenarioLabel}</strong>
                            <span className="insights-kpi-subtitle">
                              {insightsData.scenarioNarrative}
                            </span>
                          </div>
                          <div className="insights-kpi">
                            <span className="insights-kpi-label">Executive summary</span>
                            <strong>{insightsData.summary}</strong>
                            <span className="insights-kpi-subtitle">
                              {copilotModel.headline}
                            </span>
                          </div>
                        </div>

                        <div className="insights-columns">
                          <div className="insights-column">
                            <div className="insights-column-header">
                              <h4>Cost drivers</h4>
                              <span>{insightsData.drivers.length} signals</span>
                            </div>
                            {driverGroups.length ? (
                              driverGroups.map((group) => (
                                <div key={group.category} className="insights-group">
                                  <div className="insights-group-title">{group.category}</div>
                                  <div className="insights-group-items">
                                    {group.items.map((item) => (
                                      <div key={item.label} className={`insights-item insights-item--${item.impact}`}>
                                        <div className="insights-item-head">
                                          <strong>{item.label}</strong>
                                          <span className={`insights-impact insights-impact--${item.impact}`}>
                                            {item.impact}
                                          </span>
                                        </div>
                                        <p>{item.description}</p>
                                        <span className="insights-meta">
                                          Sources: {item.sources?.join(", ") || "Workspace"}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="insights-empty">
                                Add more detail to surface stronger drivers.
                              </div>
                            )}
                          </div>

                          <div className="insights-column">
                            <div className="insights-column-header">
                              <h4>Cost savings</h4>
                              <span>{insightsData.savings.length} levers</span>
                            </div>
                            {savingsGroups.length ? (
                              savingsGroups.map((group) => (
                                <div key={group.category} className="insights-group insights-group--savings">
                                  <div className="insights-group-title">{group.category}</div>
                                  <div className="insights-group-items">
                                    {group.items.map((item) => (
                                      <div key={item.label} className={`insights-item insights-item--${item.impact}`}>
                                        <div className="insights-item-head">
                                          <strong>{item.label}</strong>
                                          <span className={`insights-impact insights-impact--${item.impact}`}>
                                            {item.impact}
                                          </span>
                                        </div>
                                        <p>{item.description}</p>
                                        <span className="insights-meta">
                                          Sources: {item.sources?.join(", ") || "Workspace"}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="insights-empty">
                                Capture reuse, optimization, or managed-service levers to highlight savings.
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </section>
                ) : (
                  <>
                    {!workspace ? (
                      <div className="editor-banner">
                        Open a workspace to save. You can still edit locally.
                      </div>
                    ) : null}
                    {editorIsMarkdown ? (
                      <MarkdownEditor
                        markdown={
                          previewingEdit
                            ? previewEdit?.newContent ?? ""
                            : activeEditor.kind === "core"
                            ? drafts[activeEditor.id]
                            : supplementalDrafts[activeEditor.file.path] ?? ""
                        }
                        onChange={(value) => {
                          if (previewingEdit) return;
                          if (activeEditor.kind === "core") {
                            setDrafts((current) => ({
                              ...current,
                              [activeEditor.id]: value
                            }));
                            return;
                          }
                          const path = activeEditor.file.path;
                          setSupplementalDrafts((current) => ({
                            ...current,
                            [path]: value
                          }));
                        }}
                        readOnly={previewingEdit}
                        placeholder="Start writing..."
                        modeOverride={
                          agentRefineActive && editorIsMarkdown ? "preview" : null
                        }
                      />
                    ) : (
                      <PlainTextEditor
                        value={
                          previewingEdit
                            ? previewEdit?.newContent ?? ""
                            : activeEditor.kind === "supplemental"
                            ? supplementalDrafts[activeEditor.file.path] ?? ""
                            : ""
                        }
                        onChange={(value) => {
                          if (previewingEdit) return;
                          if (activeEditor.kind !== "supplemental") return;
                          const path = activeEditor.file.path;
                          setSupplementalDrafts((current) => ({
                            ...current,
                            [path]: value
                          }));
                        }}
                        readOnly={previewingEdit}
                        placeholder="Start writing..."
                      />
                    )}
                    {csvPreviewEnabled && csvPreviewOpen ? (
                      <div className="csv-preview">
                        {csvPreviewRows ? (
                          <table>
                            <thead>
                              <tr>
                                {csvPreviewRows[0].map((cell, index) => (
                                  <th key={`head-${index}`}>{cell}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {csvPreviewRows.slice(1).map((row, rowIndex) => (
                                <tr key={`row-${rowIndex}`}>
                                  {row.map((cell, cellIndex) => (
                                    <td key={`cell-${rowIndex}-${cellIndex}`}>
                                      {cell}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : (
                          <div className="csv-empty">
                            Not enough rows to render a table preview.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              {rightPanelOpen && (
                <div
                  className="resize-handle"
                  onMouseDown={handleResizeStart}
                  data-tooltip="Drag to resize panels"
                />
              )}

              {rightPanelOpen ? (
                <aside className="editor-side">
                  <div className="side-header">
                    <h3>Panel</h3>
                    <button
                      className="ghost"
                      onClick={() => setRightPanelOpen(false)}
                    >
                      Collapse
                    </button>
                  </div>
                  <div className="side-tabs">
                    <button
                      className={`tab ${
                        rightPanelTab === "details" ? "tab--active" : ""
                      }`}
                      onClick={() => setRightPanelTab("details")}
                    >
                      Details
                    </button>
                    <button
                      className={`tab ${
                        rightPanelTab === "copilot" ? "tab--active" : ""
                      }`}
                      onClick={() => setRightPanelTab("copilot")}
                    >
                      Copilot
                      {workspace && <span className="tab-workspace-dot" title={`Workspace: ${workspace.name ?? "current"}`} />}
                    </button>
                    <button
                      className={`tab ${
                        rightPanelTab === "chat" ? "tab--active" : ""
                      }`}
                      onClick={() => setRightPanelTab("chat")}
                    >
                      Chat
                      {workspace && <span className="tab-workspace-dot" title={`Workspace: ${workspace.name ?? "current"}`} />}
                    </button>
                    <button
                      className={`tab ${
                        rightPanelTab === "settings" ? "tab--active" : ""
                      }`}
                      onClick={() => setRightPanelTab("settings")}
                    >
                      Settings
                    </button>
                  </div>

                  {rightPanelTab === "details" ? (
                    <div className="side-section">
                      <h4>Active file</h4>
                      <p>{activeEditorLabel}</p>
                      <p className="muted">{activeDescription}</p>
                    </div>
                  ) : rightPanelTab === "copilot" ? (
                    <div className="side-section copilot-panel">
                      <div className="copilot-hero">
                        <div>
                          <div className="chat-header">
                            <h4>Estimate Copilot</h4>
                            {workspace && (
                              <span className="workspace-scope-tag" title="Analysis is specific to this workspace">
                                {workspace.name ?? "Workspace"}
                              </span>
                            )}
                          </div>
                          <p className="muted">{copilotModel.headline}</p>
                        </div>
                        <button className="ghost" onClick={openChatPanel}>
                          Refine in chat
                        </button>
                      </div>

                      {!workspace ? (
                        <div className="copilot-empty">
                          <h5>Let's get started</h5>
                          <p>
                            Create or select a workspace to see your first
                            AI-powered cost estimate.
                          </p>
                          <div className="copilot-demo-steps">
                            <span>1. Create or pick a workspace</span>
                            <span>2. Enter baseline assumptions</span>
                            <span>3. Add supporting context</span>
                            <span>4. Generate estimate brief</span>
                          </div>
                          <div className="copilot-inline-actions">
                            <button onClick={startTrainingMode}>Start Guide Mode</button>
                            <button className="ghost" onClick={addWorkspace}>
                              New workspace
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="copilot-summary-card">
                            <span className="copilot-eyebrow">Recommended range</span>
                            <div className="copilot-range">
                              {formatCurrency(activeScenario.low)} to{" "}
                              {formatCurrency(activeScenario.high)}
                            </div>
                            <p className="copilot-summary-copy">
                              {copilotModel.executiveSummary}
                            </p>
                            <div className="copilot-confidence-row">
                              <span className="copilot-confidence-label">
                                {copilotModel.confidenceLabel}
                              </span>
                              <div className="copilot-confidence-meter">
                                <span
                                  className="copilot-confidence-meter-fill"
                                  style={{
                                    width: `${Math.max(
                                      12,
                                      Math.min(100, activeScenario.confidence)
                                    )}%`
                                  }}
                                />
                              </div>
                              <span className="copilot-confidence-score">
                                {activeScenario.confidence}%
                              </span>
                            </div>
                          </div>

                          <div className="copilot-scenarios">
                            {(["lean", "expected", "conservative"] as const).map(
                              (scenarioId) => {
                                const scenario = copilotModel.scenarios[scenarioId];
                                return (
                                  <button
                                    key={scenarioId}
                                    className={`copilot-scenario-chip ${
                                      copilotScenario === scenarioId
                                        ? "copilot-scenario-chip--active"
                                        : ""
                                    }`}
                                    onClick={() => setCopilotScenario(scenarioId)}
                                  >
                                    <span>{scenario.label}</span>
                                    <strong>
                                      {formatCurrency(scenario.low)} -{" "}
                                      {formatCurrency(scenario.high)}
                                    </strong>
                                  </button>
                                );
                              }
                            )}
                          </div>

                          <div className="copilot-grid">
                            <section className="copilot-card">
                              <div className="copilot-card-header">
                                <h5>Top cost drivers</h5>
                                <span>{copilotModel.drivers.length} signals</span>
                              </div>
                              {copilotModel.drivers.length ? (
                                <div className="copilot-list">
                                  {copilotModel.drivers.map((driver) => (
                                    <div key={driver.id} className="copilot-driver">
                                      <div className="copilot-driver-row">
                                        <strong>{driver.label}</strong>
                                        <span
                                          className={`copilot-impact copilot-impact--${driver.impact}`}
                                        >
                                          {driver.impact}
                                        </span>
                                      </div>
                                      <p>{driver.description}</p>
                                      <span className="copilot-meta">
                                        Sources: {driver.sources.join(", ") || "Workspace"}
                                      </span>
                                      <span className="copilot-meta">
                                        {driver.rangeImpact}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="muted">
                                  Add more context to surface stronger cost drivers.
                                </p>
                              )}
                            </section>

                            <section className="copilot-card">
                              <div className="copilot-card-header">
                                <h5>Confidence and unknowns</h5>
                                <span>{copilotModel.unknowns.length} gaps</span>
                              </div>
                              <div className="copilot-list">
                                {copilotModel.unknowns.length ? (
                                  copilotModel.unknowns.map((unknown, index) => (
                                    <div key={`${unknown}-${index}`} className="copilot-note copilot-note--warn">
                                      {unknown}
                                    </div>
                                  ))
                                ) : (
                                  <div className="copilot-note copilot-note--ok">
                                    Current workspace context is strong enough for a finance-facing working estimate.
                                  </div>
                                )}
                                {copilotModel.assumptions.map((assumption, index) => (
                                  <div key={`${assumption}-${index}`} className="copilot-note">
                                    {assumption}
                                  </div>
                                ))}
                              </div>
                            </section>

                            <section className="copilot-card">
                              <div className="copilot-card-header">
                                <h5>Recommended next questions</h5>
                                <span>{copilotModel.nextQuestions.length} prompts</span>
                              </div>
                              <div className="copilot-list">
                                {copilotModel.nextQuestions.length ? (
                                  copilotModel.nextQuestions.map((item) => (
                                    <div key={item.id} className="copilot-question">
                                      <strong>{item.question}</strong>
                                      <p>{item.reason}</p>
                                      <button
                                        className="ghost copilot-inline-btn"
                                        onClick={() =>
                                          item.target === "context"
                                            ? focusContextCollection()
                                            : queueCopilotQuestion(
                                                item.target,
                                                item.question
                                              )
                                        }
                                      >
                                        {item.target === "context"
                                          ? "Gather context"
                                          : `Add to ${item.target}.md`}
                                      </button>
                                    </div>
                                  ))
                                ) : (
                                  <p className="muted">
                                    No critical follow-up questions detected right now.
                                  </p>
                                )}
                              </div>
                            </section>

                            <section className="copilot-card">
                              <div className="copilot-card-header">
                                <h5>Review and traceability</h5>
                                <span>Grounded in workspace</span>
                              </div>
                              <div className="copilot-trace-grid">
                                <div className="copilot-trace-stat">
                                  <span>Baseline</span>
                                  <strong>{copilotModel.sourceCoverage.baseline}%</strong>
                                </div>
                                <div className="copilot-trace-stat">
                                  <span>Requirements</span>
                                  <strong>{copilotModel.sourceCoverage.requirements}%</strong>
                                </div>
                                <div className="copilot-trace-stat">
                                  <span>Tasks</span>
                                  <strong>{copilotModel.sourceCoverage.tasks}%</strong>
                                </div>
                                <div className="copilot-trace-stat">
                                  <span>Context</span>
                                  <strong>{copilotModel.sourceCoverage.context}%</strong>
                                </div>
                              </div>
                              <div className="copilot-list">
                                {copilotModel.traceability.map((item, index) => (
                                  <div key={`${item.label}-${index}`} className="copilot-trace-item">
                                    <strong>{item.label}</strong>
                                    <p>{item.detail}</p>
                                    <span className="copilot-meta">{item.source}</span>
                                  </div>
                                ))}
                              </div>
                            </section>
                          </div>

                          <div className="copilot-action-bar">
                            <button onClick={queueCopilotEstimate}>
                              Queue estimate brief
                            </button>
                            <button className="ghost" onClick={generateEstimateMarkdown}>
                              Create blank estimate file
                            </button>
                          </div>

                          {pendingEdits.length > 0 && (
                            <section className="proposed-updates-panel">
                              <div className="proposed-updates-header">
                                <h5>Proposed updates to your files</h5>
                                <span className="proposed-updates-count">{pendingEdits.length}</span>
                              </div>
                              <p className="proposed-updates-desc">
                                The AI copilot suggests these changes. Review and apply them to update your estimate.
                              </p>
                              <div className="proposed-updates-list">
                                {pendingEdits.map((edit) => {
                                  const diff = summarizeDiff(
                                    edit.originalContent,
                                    edit.newContent
                                  );
                                  const fileType = edit.kind === "core" ? "Core file" : "Supporting document";
                                  return (
                                    <div key={edit.id} className="proposed-update-card">
                                      <div className="proposed-update-header">
                                        <span className="proposed-update-file">{edit.label}</span>
                                        <span className="proposed-update-type">{fileType}</span>
                                      </div>
                                      <div className="proposed-update-diff">
                                        <span className="proposed-update-added">+{diff.added}</span>
                                        <span className="proposed-update-removed">-{diff.removed}</span>
                                      </div>
                                      {diff.highlights.length > 0 && (
                                        <div className="proposed-update-preview">
                                          {diff.highlights.map((line, index) => (
                                            <code key={`${edit.id}-preview-${index}`}>{line}</code>
                                          ))}
                                        </div>
                                      )}
                                      <div className="proposed-update-actions">
                                        <button
                                          className="proposed-update-btn proposed-update-btn--apply"
                                          onClick={() => acceptEdit(edit)}
                                          data-tooltip="Apply this change to your file"
                                        >
                                          Apply
                                        </button>
                                        <button
                                          className="proposed-update-btn proposed-update-btn--discard"
                                          onClick={() => rejectEdit(edit)}
                                          data-tooltip="Discard this suggestion"
                                        >
                                          Discard
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </section>
                          )}
                        </>
                      )}
                    </div>
                  ) : rightPanelTab === "chat" ? (
                    <div className="side-section">
                      <div className="chat-header">
                        <h4>Chat</h4>
                        {workspace && (
                          <span className="workspace-scope-tag" title="Chat history is specific to this workspace">
                            {workspace.name ?? "Workspace"}
                          </span>
                        )}
                      </div>
                      {!workspace ? (
                        <div className="copilot-empty">
                          <h5>Select a workspace</h5>
                          <p>
                            Open or create a workspace to start chatting with
                            the AI assistant about your estimate.
                          </p>
                          <div className="copilot-inline-actions">
                            <button onClick={addWorkspace}>New workspace</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="chat-split">
                            <div className="chat-pane">
                              <h5>Model output</h5>
                              <div className="chat-log" ref={chatLogRef}>
                                {!editorIsMarkdown && !csvPreviewEnabled ? (
                                  <p className="muted">
                                    Chat refinement is available for estimate
                                    files.
                                  </p>
                                ) : chatMessages.length ? (
                                  chatMessages.map((message, index) => (
                                    <div
                                      key={`${message.role}-${index}`}
                                      className={`chat-bubble chat-${message.role}`}
                                    >
                                      <div
                                        className="chat-bubble-content"
                                        dangerouslySetInnerHTML={{
                                          __html: editorController.markdownToHtml(
                                            message.text
                                          )
                                        }}
                                      />
                                    </div>
                                  ))
                                ) : (
                                  <p className="muted">
                                    Ask questions or request changes to your estimate.
                                  </p>
                                )}
                                {chatLoading && (
                                  <div className="chat-bubble chat-agent chat-loading">
                                    <span className="chat-typing-indicator">
                                      <span></span>
                                      <span></span>
                                      <span></span>
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="chat-pane">
                              <h5>Reasoning output</h5>
                              <div className="chat-log chat-log--reasoning">
                                <p className="muted">
                                  Reasoning stream will appear here when enabled.
                                </p>
                              </div>
                            </div>
                          </div>
                      {pendingEdits.length > 0 && (
                        <div className="pending-edits-panel">
                          <div className="pending-edits-header">
                            <h5>Proposed updates to your files ({pendingEdits.length})</h5>
                            <p className="muted">
                              These changes were suggested by the estimator for this workspace. Review and apply when you are ready.
                            </p>
                          </div>
                              <div className="pending-edits-list">
                                {pendingEdits.map((edit) => {
                              const diff = summarizeDiff(
                                edit.originalContent,
                                edit.newContent
                              );
                              const typeLabel =
                                edit.kind === "core"
                                  ? "Core file"
                                  : edit.kind === "newSupplemental"
                                  ? "New supporting file"
                                  : edit.fileId.includes("context")
                                  ? "Context document"
                                  : "Supporting file";
                                  return (
                                <div key={edit.id} className="pending-edit-card">
                                  <div className="pending-edit-info">
                                    <span className="pending-edit-file">
                                      {edit.label}
                                      <span className="pending-edit-type"> · {typeLabel}</span>
                                    </span>
                                    <span className="pending-edit-summary">
                                      +{diff.added} / -{diff.removed}
                                    </span>
                                    {diff.highlights.length ? (
                                      <div className="pending-edit-highlights">
                                        {diff.highlights.map((line, index) => (
                                          <code key={`${edit.id}-line-${index}`}>
                                            {line}
                                          </code>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="pending-edit-actions">
                                    <button
                                      className="pending-edit-btn pending-edit-btn--preview"
                                      onClick={() => {
                                        setPreviewEditId(edit.id);
                                        setMainTab("editor");
                                      }}
                                      title="Preview this update"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <circle cx="12" cy="12" r="3" />
                                        <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6z" />
                                      </svg>
                                    </button>
                                    <button
                                      className="pending-edit-btn pending-edit-btn--accept"
                                      onClick={() => acceptEdit(edit)}
                                      title="Apply this update to the workspace"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polyline points="20 6 9 17 4 12" />
                                      </svg>
                                    </button>
                                    <button
                                      className="pending-edit-btn pending-edit-btn--reject"
                                      onClick={() => rejectEdit(edit)}
                                      title="Discard this update"
                                    >
                                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      <div className="chat-input">
                        {chatContextFiles.length > 0 && (
                          <div className="chat-attachments">
                            {chatContextFiles.map((file, index) => (
                              <div key={`${file.name}-${index}`} className="chat-attachment">
                                <svg className="chat-attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                  <polyline points="14 2 14 8 20 8"/>
                                </svg>
                                <span className="chat-attachment-name">{file.name}</span>
                                <button
                                  className="chat-attachment-remove"
                                  onClick={() => removeChatContextFile(index)}
                                  data-tooltip="Remove file"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="chat-composer">
                          <div className="chat-composer-editor-wrap">
                            <textarea
                              className="chat-composer-input"
                              value={chatInput}
                              onChange={(e) => setChatInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  sendChatMessage();
                                }
                              }}
                              placeholder="Ask the estimator…"
                              rows={4}
                            />
                          </div>
                          <div className="chat-composer-bar">
                            <label className="chat-composer-plus" data-tooltip="Attach files to context-documents">
                              <input
                                type="file"
                                multiple
                                onChange={handleChatFileSelect}
                                style={{ display: "none" }}
                              />
                              +
                            </label>
                            <div className="chat-mode-menu">
                              <button
                                type="button"
                                className="chat-mode-dropdown"
                                onClick={() => setChatModeMenuOpen((prev) => !prev)}
                                data-tooltip="Choose chat mode"
                              >
                                <svg className="chat-mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  {chatMode === "agent" ? (
                                    <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
                                  ) : (
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                  )}
                                </svg>
                                <span>{chatMode === "agent" ? "Agent" : "Ask"}</span>
                                <svg className="chat-mode-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="6 9 12 15 18 9" />
                                </svg>
                              </button>
                              {chatModeMenuOpen ? (
                                <div className="chat-mode-menu-popover">
                                  <button
                                    type="button"
                                    className={`chat-mode-option ${chatMode === "agent" ? "active" : ""}`}
                                    onClick={() => {
                                      setChatMode("agent");
                                      setChatModeMenuOpen(false);
                                    }}
                                  >
                                    <svg className="chat-mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
                                    </svg>
                                    Agent
                                  </button>
                                  <button
                                    type="button"
                                    className={`chat-mode-option ${chatMode === "ask" ? "active" : ""}`}
                                    onClick={() => {
                                      setChatMode("ask");
                                      setChatModeMenuOpen(false);
                                    }}
                                  >
                                    <svg className="chat-mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                    </svg>
                                    Ask
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            <select
                              className="chat-model-dropdown"
                              value={settingsModel}
                              onChange={(event) => setSettingsModel(event.target.value)}
                              title="Select chat model"
                            >
                              <option value="openai/gpt-4o-mini">GPT-4o mini</option>
                              <option value="openai/gpt-4o">GPT-4o</option>
                              <option value="openai/gpt-5.2">GPT-5.2</option>
                              <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                              <option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash</option>
                            </select>
                            <button
                              type="button"
                              className="chat-composer-send"
                              onClick={sendChatMessage}
                              disabled={chatLoading || (!chatInput.trim() && chatContextFiles.length === 0)}
                              data-tooltip={chatLoading ? "Thinking…" : "Send"}
                            >
                              {chatLoading ? (
                                <span className="chat-composer-spinner" />
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="22" y1="2" x2="11" y2="13"/>
                                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="side-section">
                      <h4>Settings</h4>
                      <label>Provider</label>
                      <select
                        className="text-input"
                        value={settingsProvider}
                        onChange={(event) =>
                          setSettingsProvider(event.target.value)
                        }
                      >
                        <option value="openrouter">OpenRouter</option>
                        <option value="openai">OpenAI (Direct)</option>
                        <option value="anthropic">Anthropic (Direct)</option>
                      </select>
                      <label>Model</label>
                      <select
                        className="text-input"
                        value={settingsModel}
                        onChange={(event) => setSettingsModel(event.target.value)}
                      >
                        <option value="openai/gpt-4o-mini">openai/gpt-4o-mini</option>
                        <option value="openai/gpt-4o">openai/gpt-4o</option>
                        <option value="openai/gpt-5.2">openai/gpt-5.2</option>
                        <option value="anthropic/claude-3.5-sonnet">anthropic/claude-3.5-sonnet</option>
                        <option value="google/gemini-2.0-flash-001">google/gemini-2.0-flash-001</option>
                      </select>
                      <label>API key</label>
                      <input
                        className="text-input"
                        type="password"
                        value={settingsApiKey}
                        onChange={(event) =>
                          setSettingsApiKey(event.target.value)
                        }
                        placeholder={
                          settingsHasKey && settingsKeySuffix
                            ? `••••••••${settingsKeySuffix}`
                            : "Paste API key"
                        }
                      />
                      <p className="muted">
                        Leave blank to keep the saved key. Keys are stored
                        securely and persist across sessions.
                      </p>
                      <div className="setup-actions">
                        <button onClick={saveSettings}>Save settings</button>
                      </div>
                      {settingsStatus ? (
                        <p className="muted">{settingsStatus}</p>
                      ) : null}
                      {settingsHasKey && settingsKeySuffix ? (
                        <p className="muted">
                          Stored key ends with {settingsKeySuffix}.
                        </p>
                      ) : null}
                    </div>
                  )}
                </aside>
              ) : null}
            </div>
          )}
        </section>
      </main>

      {newWorkspaceModalOpen && (
        <div className="modal-overlay">
          <div className="modal-dialog">
            <div className="modal-header">
              <h3>New Workspace</h3>
              <button
                className="modal-close"
                onClick={() => setNewWorkspaceModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-content">
              <div className="field">
                <label>Workspace Name</label>
                <input
                  className="text-input"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="e.g. Project Alpha"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateWorkspace();
                  }}
                />
                <p className="muted">
                  This will create a new folder in your default workspaces directory.
                </p>
              </div>
              <div className="action-row" style={{ marginTop: "16px", justifyContent: "flex-end" }}>
                <button className="ghost" onClick={() => setNewWorkspaceModalOpen(false)}>
                  Cancel
                </button>
                <button onClick={handleCreateWorkspace} disabled={openingWorkspace}>
                  {openingWorkspace ? "Creating..." : "Create Workspace"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Training Mode Overlay */}
      {trainingMode && currentTrainingStep && (
        <div className="training-overlay">
          <div className="training-spotlight" data-highlight={currentTrainingStep.highlight || "none"} />
          <div className="training-panel">
            <div className="training-progress">
              {TRAINING_STEPS.map((step, index) => (
                <div
                  key={step.id}
                  className={`training-progress-dot ${index === trainingStepIndex ? "active" : ""} ${index < trainingStepIndex ? "completed" : ""}`}
                />
              ))}
            </div>
            <div className="training-content">
              <h2>{currentTrainingStep.title}</h2>
              <p>{currentTrainingStep.description}</p>
              {currentTrainingStep.highlight && currentTrainingStep.highlight !== "export" && currentTrainingStep.highlight !== "chat" && (
                <div className="training-hint">
                  <svg className="training-hint-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                  <span>The {currentTrainingStep.highlight} section is highlighted. Review the pre-filled content to understand the pattern.</span>
                </div>
              )}
              {currentTrainingStep.action && (
                <div className="training-action-buttons">
                  {currentTrainingStep.action === "viewEstimate" && (
                    <button
                      className="training-btn training-btn--action"
                      onClick={() => handleTrainingAction("viewEstimate")}
                      data-tooltip="Open the generated cost estimate document showing phase breakdown, labor costs, infrastructure costs, and 5-year TCO"
                    >
                      <svg className="training-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="16" y1="13" x2="8" y2="13"/>
                        <line x1="16" y1="17" x2="8" y2="17"/>
                        <polyline points="10 9 9 9 8 9"/>
                      </svg>
                      View Cost Estimate
                    </button>
                  )}
                  {currentTrainingStep.action === "showExport" && (
                    <div className="training-export-options">
                      <button
                        className="training-btn training-btn--action"
                        onClick={() => {
                          handleTrainingAction("showExport");
                        }}
                        data-tooltip="Export your estimate as a Microsoft Word document (.docx) for sharing with stakeholders and formal submissions"
                      >
                        <svg className="training-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 4v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6a2 2 0 0 0-2 2z"/>
                          <path d="M14 2v6h6"/>
                          <path d="M9 13h6"/>
                          <path d="M9 17h3"/>
                        </svg>
                        Export as Word
                      </button>
                      <button
                        className="training-btn training-btn--action"
                        onClick={() => {
                          setStatusMessage("PDF export would generate a formatted PDF. (Demo only)");
                        }}
                        data-tooltip="Generate a PDF version of your estimate for printing, archiving, or email attachments"
                      >
                        <svg className="training-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <path d="M10 12h4"/>
                          <path d="M10 16h4"/>
                          <path d="M8 12v4"/>
                        </svg>
                        Export as PDF
                      </button>
                    </div>
                  )}
                  {currentTrainingStep.action === "openChat" && (
                    <button
                      className="training-btn training-btn--action"
                      onClick={() => handleTrainingAction("openChat")}
                      data-tooltip="Open the AI chat panel to refine estimates, ask questions, adjust calculations, or get suggestions for improving your deliverables"
                    >
                      <svg className="training-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                      Open Chat Panel
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="training-actions">
              <button
                className="training-btn training-btn--secondary"
                onClick={exitTrainingMode}
              >
                Exit Training
              </button>
              <div className="training-nav">
                {trainingStepIndex > 0 && (
                  <button
                    className="training-btn training-btn--ghost"
                    onClick={previousTrainingStep}
                  >
                    ← Back
                  </button>
                )}
                <button
                  className="training-btn training-btn--primary"
                  onClick={advanceTrainingStep}
                >
                  {trainingStepIndex === TRAINING_STEPS.length - 1 ? "Finish" : "Next →"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
