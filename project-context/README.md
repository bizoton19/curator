# Bilomax Desktop – Project Scaffold

This repository contains a production-oriented scaffold for Bilomax Desktop: a cross-platform Electron + React + TypeScript app with a local .NET Minimal API for DOCX rendering.

The structure is derived from the V1 Master Specification and sets up the core layers: Desktop, Agent, and DOCX rendering services.

## Structure
- `apps/desktop` Electron + React + TypeScript app
- `services/docx-renderer` .NET Minimal API for Markdown → DOCX rendering
- `docs` Product/architecture notes and workflow definitions
- `baseline.md` Project assumptions
- `requirements.md` Product requirements
- `tasks.md` Execution tasks
- `bilomax-v1-master.md` Source specification

## Quick Start (local)
Desktop app:
1. `cd apps/desktop`
2. `npm install`
3. `npm run dev`

DOCX renderer:
1. `cd services/docx-renderer`
2. `dotnet run`

## Notes
- The DOCX renderer is a stub with placeholder routes. Wire in Open XML SDK or OfficeIMO for real rendering.
- The Desktop app includes core module boundaries for Markdown, orchestration, permissions, and capabilities.
