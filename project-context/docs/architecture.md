# Architecture Overview

## Desktop Layer
- Electron main process
- React renderer
- IPC bridge for safe file access

## Agent Layer
- Local Codex CLI executor
- Sequential or parallel run modes
- Streaming output to UI

## Core Modules
1. Markdown Workspace Manager
2. WYSIWYG Markdown Editor (tables required)
3. Agent Orchestrator
4. File Permission Gate
5. Config Manager
6. Capability Framework
7. DOCX Rendering Client

## Workspace Library
- App-managed workspace root under the user profile
- Default workspace auto-created
- Sidebar workspace tree with nested files and folders
