# Requirements

## Core

- Markdown workspace manager for `baseline.md`, `requirements.md`, and `tasks.md`
- WYSIWYG Markdown editor with table support
- Multi-agent orchestration with streaming output
- File permission gate for user-approved access
- Capability framework for extensible plugins
- DOCX export via local renderer
- Estimate Copilot workspace layer for finance-facing estimation workflows

## UX

- Guided baseline wizard
- Clear progress across `PLAN -> EXECUTE -> REVIEW -> REFINE`
- Output review and file-change summary
- Primary estimation workflow should feel like an AI copilot, not just an editor with chat
- **Refinement:** Elevate `Execute` into a finance-facing estimation action with visible drivers, scenarios, and review outputs
- **Refinement:** Visual task progress during execution phase
- **Refinement:** Dockable/split-view for examples to allow reference while editing
- **Planned:** WYSIWYG editing mode so users author without raw markdown syntax while markdown remains canonical for AI processing
- **Planned:** Resizable panels between editor and side panel
- **Planned:** Collapsible left sidebar for maximum editing real estate
- **Planned:** Context file upload via chat into `context-documents/`
- **Planned:** Interactive training module with a pre-filled example workspace
- **Planned:** Rich tooltips on action buttons
- **Spec:** Left sidebar Workspaces/Steps tabs, explorer toolbar, earlier context capture, and prompt-based wizard guidance are defined in `docs/workspace-sidebar-and-wizard-ux.md`

## Technical

- Electron + React + TypeScript
- IPC boundary for file system access
- Local DOCX rendering path
- Secure, local-only output generation
- Chat-driven file edits use structured `curator_edits` payloads and pending review actions
- Per-workspace persistence stores chat history, snapshots, and last-opened context
- Estimate Copilot derives structured estimation signals from workspace content and surfaces them as scenario-ready summaries
- Full-text search must cover all text-based files, including converted Office docs (`.docx`, `.pdf`, `.pptx`, `.xlsx`) via Markdown sidecars; search hits should open the converted Markdown view for binary sources
- File handling rules:
  - `.xlsx` is converted to tab-delimited text for table preview + chat context
  - `.docx` is converted to Markdown for preview + chat context
  - `.pdf` is converted to Markdown when text-based; scanned PDFs show a “Preview unavailable” notice and are not searchable without OCR
  - `.pptx` is converted to Markdown with slide sections
  - Images are not converted or searchable (future vision support)
- In-app help knowledge base: the chat window must be able to answer “how to” questions about the app UI and explain product terms (baseline, requirements, tasks, context documents) using a built-in knowledge base, without requiring external docs

## Product UX Vision

Curator should feel like an AI estimation copilot for finance, pricing, and PMO teams who need to move from incomplete discovery inputs to a defensible estimate quickly.

### North Star

- Minimize friction from first launch to first estimate brief.
- Keep source context visible while editing and reviewing.
- Make next actions obvious when confidence is low or assumptions are weak.
- Transform rough notes into decision-ready estimation outputs.

### UX Principles

- Speed first: one-click actions, keyboard-friendly flows, and sensible defaults.
- Guided but flexible: onboarding is clear, guidance is collapsible, and any workspace file can still be edited directly.
- Continuous feedback loop: users should always see readiness, confidence, and what changed.
- Professional clarity: concise copy, executive-grade layouts, and responsive panels that prioritize decision making.
- Maximum real estate: collapsible sidebar and resizable panels protect authoring space.
- Context-aware input: attach reference documents directly via chat and keep them grounded in the estimate.
- Estimator-native intelligence: elevate cost range, drivers, assumptions, scenarios, and traceability above raw document editing.

### Estimate Copilot Quality Bar

- Copilot must generate an estimation brief from current workspace context.
- Copilot must expose `lean`, `expected`, and `conservative` scenarios.
- Copilot must show a visible confidence signal with missing-information prompts.
- Copilot must surface top cost drivers and trace them back to workspace sources.
- Copilot actions must feed the existing pending-edit workflow so users can review before applying.

### Requirements Step Quality Bar

- Requirements input must support fast structured drafting for goals, constraints, acceptance criteria, pricing inputs, and dependencies.
- The interface should reduce cognitive load with progressive disclosure and reusable examples.
- The screen should remain responsive and readable at common laptop widths without hiding critical actions.
- The step should make estimator unknowns visible enough that a finance user knows what to ask next.
