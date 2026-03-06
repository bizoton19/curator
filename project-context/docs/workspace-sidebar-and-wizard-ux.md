# Workspace Sidebar + Wizard UX Spec

## Goal

Make Curator feel like a professional, finance-facing estimation workstation by:

- Providing a **VS Code-like** workspace explorer for files and folders.
- Making **Steps** a first-class navigation surface (not hidden inside the main canvas).
- Guiding users through authoring the core documents with **prompted questions** and **early context capture**.
- Eliminating UI crowding and any “dashboard-like” overlays that steal editor space.

This spec focuses on the **left sidebar**, the **wizard guidance**, and **layout density/spacing**.

## Left Sidebar: Tabs and Layout

### Tabs

The left sidebar has exactly two top-level tabs:

- **Workspaces**: workspace switcher + file explorer for the active workspace
- **Steps**: vertical step navigation (bigger, labeled, clearly clickable)

### Workspaces tab requirements

#### File explorer (active workspace)

- **Tree view**:
  - Shows folders and files inside the workspace (core files and supplemental files).
  - Supports expand/collapse and a clear selection state.
  - Supports keyboard navigation (up/down, enter to open, left/right to collapse/expand).

- **Core docs are always visible**:
  - `baseline.md`, `requirements.md`, `tasks.md` should be pinned/sectioned at top.
  - The user should be able to open/edit any file at any time.

#### Explorer toolbar

The Workspaces tab includes an explorer toolbar row with actions commonly expected by users of file explorers:

- **New file**
- **New folder**
- **Search**
- **Collapse/Expand all**

Toolbar requirements:

- Every action must have a **visible label** or an **icon + tooltip** that makes the purpose obvious.
- Buttons must have sufficient contrast against the background.
- Spacing must avoid mis-clicks and feel intentional (no stacked, overlapping, or jammed controls).

### Steps tab requirements

The Steps tab is a vertical, labeled navigation. It should be larger and clearer than the compact horizontal step strip.

Minimum behavior:

- Shows the full step list with labels (e.g. Baseline, Context, Requirements, Tasks, Estimate, Review/Export).
- Clicking a step moves the editor to the relevant file/section.
- A “current step” state is visible.

## Wizard Guidance: Prompted Authoring, Not Just Navigation

### Problem

Users can open the files, but they still need help writing finance-grade content quickly. The wizard must do more than move between steps: it should **prompt the right questions** and guide users to fill sections that materially improve estimate quality.

### Requirements

For each core file, provide a small, collapsible guidance panel that:

- Shows **3–8 prompts** tailored to the file
- Lets users insert prompts as bullet items into the document (reviewable when inserted by automation)
- Surfaces when the content is “thin” (low coverage) and suggests next questions

#### Baseline prompts (examples)

- What is the project’s business objective and success metric?
- What is explicitly in scope and out of scope?
- What delivery assumptions are being made (team availability, environments, access)?
- What constraints exist (dates, governance, procurement)?

#### Requirements prompts (examples)

- What is the budget guardrail or commercial target?
- What are acceptance criteria and non-functional requirements?
- What dependencies or integrations exist?
- What compliance/privacy/security constraints apply?

#### Tasks prompts (examples)

- What are the Plan/Execute/Review/Refine workstreams?
- Who owns each task and what are the outputs?
- What context documents must be reviewed during execution?

## Context Capture Must Happen Earlier

### Rationale

If the user intends to ask AI agents (via `tasks.md`) to analyze supporting documents, they need to attach those context docs early—otherwise the agent work is under-powered and the estimate becomes less defensible.

### Context capture requirements

- The flow should bring **Context** earlier (or strongly encourage it immediately after baseline).
- The UI should make it obvious how to add context docs:
  - via a file picker/import action in the Workspaces explorer
  - via chat attachments that land in the workspace’s context folder

## Density, Spacing, and Professional Layout

### Problem statement

The left panel is currently perceived as:

- too cramped / crowded
- unprofessional spacing
- some controls visually unclear or invisible

### Layout requirements

- Use consistent spacing tokens (padding, gaps) across:
  - sidebar sections
  - toolbar buttons
  - tree items
  - tab strip
- Ensure all icon-only buttons have:
  - high contrast
  - tooltips
  - minimum hit area
- Avoid layouts where controls compete for the same visual lane (no overlapping clusters).

## “Dashboard” Overflow Must Be Removed

### Overflow problem statement

There must be no workflow-status/dashboard component that expands over (or pushes down) the core markdown editor area for baseline/requirements/tasks displays.

### Overflow requirements

- The editor view for core files must remain the primary surface.
- Any status must be small, optional, and non-invasive (e.g. subtle badge or small sidebar panel).
- No component should take “all the space” above the editor in core markdown file displays.

## Acceptance Criteria (What “Done” Looks Like)

- The left sidebar has two tabs: **Workspaces** and **Steps**, both readable and clickable.
- The Workspaces tab has a professional explorer toolbar: new file, new folder, search, collapse/expand.
- The Steps tab is vertical and labeled; it can be larger and more prominent than the previous step UI.
- The wizard guidance inserts meaningful prompts and encourages early context attachment.
- The core markdown editor is not dominated by any workflow status/dashboard overlay.
