# Baseline

## Project Overview
Curator is a cross-platform desktop application for finance-facing cost estimation workflows with multi-agent orchestration, workspace traceability, and AI-guided review.

## Scope
- Electron + React + TypeScript desktop app
- Local DOCX rendering path
- Markdown-based workspace with supplemental context files
- Estimate Copilot layer for scenario analysis and estimation guidance
- Agent orchestration for structured plan/execute/review/refine workflows
- Reviewable file-change workflow with snapshot history

## Assumptions
- Local file system access requires explicit user permission
- Markdown remains the canonical project format
- Export rendering runs locally
- Target OS: Windows and macOS (primary)
- Finance, pricing, and PMO users need confidence and traceability as much as speed

## Constraints
- Offline-friendly for core workflows
- Strict permission gating for file access
- Reliable audit trail for agent actions and accepted changes
- Copilot recommendations must remain grounded in visible workspace inputs

## Success Criteria
- Project can load and edit `baseline.md`, `requirements.md`, and `tasks.md`
- Workspace can preserve chat history and last-opened context
- Estimate Copilot can summarize cost range, confidence, drivers, and next questions from current workspace context
- Users can review, accept, or reject proposed updates before they land in workspace files
- Review mode makes assumptions, risks, and estimation traceability obvious
- DOCX export works via local renderer
