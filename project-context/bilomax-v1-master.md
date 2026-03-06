# Bilomax Desktop – V1 Master Specification

Version: 1.1
Purpose: Enterprise Cost Estimation Desktop Application with Multi-Agent Orchestration

---

# 1. Product Vision

Bilomax Desktop is a cross-platform desktop application (Windows + macOS primary) focused on enterprise cost estimation workflows and multi-agent orchestration.

The product should evolve from a document-driven workspace into an AI estimation copilot for finance, pricing, and PMO teams.

The system:

- Reads and modifies project files
- Executes multi-step workflows
- Orchestrates multiple AI agents in parallel or sequential mode
- Automates local machine tasks with explicit user permission
- Uses Markdown as the core project format
- Supports extensible Capabilities (plugins)
- Supports DOCX export including template-based rendering
- Surfaces estimator-native outputs such as cost ranges, confidence, scenarios, cost drivers, and review traceability

---

# 2. Core Workflow Model

Each project contains structured Markdown files:

- baseline.md
- requirements.md
- tasks.md

The system operates using a Ralph Loop:

PLAN → EXECUTE → REVIEW → REFINE

---

# 3. Baseline Specification

baseline.md establishes project assumptions.

## Required Sections

### Project Overview

Short description of engagement.

...

---

# 6. Architecture Overview

## Desktop Layer

Electron + React + TypeScript

- Electron main process
- Renderer (React UI)
- IPC bridge (Electron’s IPC)
- Secure file system access layer

## Agent Layer

- Codex CLI used as local agent executor
- Spawned as child process
- Streaming output supported
- Sequential or parallel execution

## Core Modules

1. Markdown Workspace Manager  
2. WYSIWYG Markdown Editor (tables required)  
3. Agent Orchestrator  
4. File Permission Gate  
5. Config Manager  
6. Capability Framework  
7. Doc Rendering Engine (local .NET worker)

## Workspace Structure

- Workspace root contains `baseline.md`, `requirements.md`, and `tasks.md`
- Left panel lists core Markdown files, other `.md` files, context documents, and templates
- File explorer lets users open any text-based file; Markdown uses rich editor, other text files use plain editor, CSV can be previewed as a table
- Default workspace is created under the app user profile (app-managed workspace library)
- Workspaces are shown in a tree with nested files/folders; users can switch workspaces from the sidebar
- `context-documents/` auto-created on workspace open/creation; accepts text/code files (`.txt`, `.md`, `.cs`, `.js`, `.json`, `.yaml`, `.java`, etc.)
- `templates/` auto-created on workspace open/creation; accepts `.docx` and `.dot` files only
- Editor area is large and file-editor-like to support long-form editing

## Guided Onboarding

- Baseline-first guided flow (TurboTax-style) with step-by-step explanations
- Examples panel is docked (not floating) and toggled from “View examples,” with formatted preview content
- Requirements step defines detailed goals/specifications for the estimate
- Tasks step explains sequential task instructions for the estimator and provides a sample `tasks.md`
- Context step explains why context matters and supports drag-drop + in-app context doc creation
- After onboarding, user enters DOCX generation flow: pick/upload template, generate `cost-estimate.md`, render DOCX, and open in native apps
- Right-side collapsible panel includes `Details`, `Copilot`, `Chat`, and `Settings` tabs
- Copilot view presents a structured estimate brief with cost range, confidence, scenarios, top cost drivers, missing inputs, and recommended next questions
- Review view behavior should explain what changed, why it matters, and which workspace inputs drove the recommendation
- Home view defaults to the last-opened file per workspace (fallback: `baseline.md`); wizard only appears for brand-new workspaces or first-time default setup

---

# 7. .NET Minimal API for DOCX Rendering

Users will be able to export Markdown to DOCX using a local document engine built with .NET Minimal APIs exposing a local HTTP or CLI interface.

### Why .NET for DOCX

- **Official libraries & tooling:** Use Microsoft’s Open XML SDK and community extensions (e.g., Openize.OpenXML-SDK, OfficeIMO) for powerful Word document manipulation without requiring Microsoft Word installed. :contentReference[oaicite:0]{index=0}  
- **Template-friendly:** Easy to programmatically replace placeholders and generate complex documents.  
- **Enterprise-ready:** Strong maintenance, cross-platform support with .NET 6 / .NET 8.

### Proposed API Contract

Example HTTP Minimal API routes for local rendering:
POST /render/plain
{
markdown: "...",
outputPath: "..."
}

POST /render/template
{
markdown: "...",
templateId: "...",
templatePath: "...",
outputPath: "..."

### Implementation Details

- Self-contained .NET executable bundled with the Electron installer  
- Uses Open XML SDK or OfficeIMO as underlying I/O layer  
- Returns results via JSON responses or writes file to disk for Electron to pick up

---

# 8. DOCX Export Capability

## Plain Markdown Export

- Convert Markdown to DOCX
- Preserve headings, tables, lists, and formatting

Output: estimate-output.docx

## Template-Based DOCX Rendering

Users upload DOCX templates into a template gallery.

- Templates store placeholders such as `{{project_name}}`, `{{labor_table}}`
- System maps structured Markdown output to template placeholders
- CAPABILITY calls local .NET worker to merge data

Templates must be sandboxed and versioned.

---

# 9. Capability Framework

Each capability implements:
interface Capability {
id: string
name: string
description: string
type: CapabilityType
execute(context): Promise<Result>

Capability Types include:

- Output Renderers
- Template Processors
- Estimation Engines
- Integration Connectors
- Post-Processing Agents

---

# 12. User Flow

1. Launch application  
2. Guided baseline wizard  
3. Complete requirements.md  
4. Create/edit tasks.md  
5. Upload supporting context documents  
6. Select model and API key  
7. Run agent loop  
8. Review output  
9. Export via capability (local .NET endpoint)

---

# 15. Implementation Tasks – Doc Engine

- Build .NET Minimal API project  
- Integrate Open XML SDK / OfficeIMO for DOCX manipulation  
- Implement endpoints for rendering plain and template DOCX  
- Generate system executable / service  
- Secure API access from Electron  
- Add logging and error reporting

---

# 17. Ralph Loop Definition

PLAN  
- Review baseline.md  
- Review requirements.md  
- Review tasks.md

EXECUTE  
- Execute tasks  
- Stream output  
- Log changes

REVIEW  
- Summarize modifications  
- Highlight changed files  
- Surface cost drivers, assumptions, and scenario deltas  
- Explain traceability back to baseline, requirements, tasks, and context documents

REFINE  
- Update tasks  
- Repeat loop

---

End of V1 Master Specification}}
