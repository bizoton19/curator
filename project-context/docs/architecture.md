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
3. Search Index + Retrieval (SQLite FTS5)
4. Agent Orchestrator
5. File Permission Gate
6. Config Manager
7. Capability Framework
8. DOCX Rendering Client

## Workspace Library
- App-managed workspace root under the user profile
- Default workspace auto-created
- Sidebar workspace tree with nested files and folders

## Search & Retrieval
- SQLite FTS5 index stored under `userData/search-index.db`
- Index builds on workspace open and updates on file save/import/create
- Explorer search uses the index for fast full-text lookup
- Chat retrieval can query the same index to attach the most relevant files
- Binary office docs are indexed via their converted Markdown sidecars (`.curator-converted/*.md`)

## File Handling Matrix

- `.md`, `.txt`, `.json`, `.yaml`, `.js`, etc. (text/code): stored as-is, searchable, editable in the text editor.
- `.csv` / `.tsv`: stored as-is, searchable, editable; table preview available.
- `.xlsx`: converted to tab-delimited text; searchable; table preview available; chat uses converted text.
- `.docx`: converted to Markdown via Mammoth; searchable; displayed as Markdown; chat uses converted text.
- `.pdf` (text-based): converted to Markdown via PDF text extraction; searchable; displayed as Markdown; chat uses converted text.
- `.pdf` (scanned/image): conversion yields no text and shows a “Preview unavailable” note; not searchable without OCR.
- `.pptx`: converted to Markdown with slide sections; searchable; displayed as Markdown; chat uses converted text.
- Images (e.g., `.png`, `.jpg`): not converted or searchable; reserved for future vision-based chat.

## In-App Help Knowledge Base

- A lightweight, bundled knowledge base (KB) explains key terms and workflows (baseline, requirements, tasks, context documents).
- The chat panel should route “how do I…” questions to the KB before external model calls.
- KB content can live as Markdown in the app bundle (or userData) and be indexed by the same SQLite FTS5 search pipeline.
- For deterministic answers, the KB response should be cited or summarized and kept separate from project context retrieval.
