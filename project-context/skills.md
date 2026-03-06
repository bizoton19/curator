# Bilomax Design Skills

This file defines the UI/UX principles and visual language for Bilomax Desktop.

## Product Intent
- State-of-the-art cost estimation workflow driven by AI models.
- Anchored by baseline + requirements files.
- Supported by context documents, templates, and outputs.

## UI/UX Principles
- Confidence-first: clear next action, minimal ambiguity, visible progress.
- Dense but breathable: dashboard-level detail without clutter.
- Clear hierarchy: surface the "what/why/next" on every screen.
- Fluent motion: small transitions, no jank, no stale state.
- Workspace-first: files are the system of record; keep editing continuous.

## Visual Direction
- Editorial-meets-technical: bold titles, precise monospace data.
- Neutral palette with strong contrast for focus.
- Tight iconography: SVG-first, simple and filled.
- A sense of "instrument panel" rather than generic app UI.

## Layout & Navigation
- Fixed top menu bar for global actions.
- Split editor + right panel (details/chat/canvas/settings).
- Dashboard strip for status + insights.
- Support desktop, tablet, and phone with fluid grid.

## Interaction Requirements
- Markdown editor for `.md` and `.markdown`.
- Plain text editor for other text-based files.
- CSV preview as table, plus editable source.
- Chat refinement forces markdown preview mode.
- WebSocket indicator for live activity.
- Canvas authoring for quick visual notes.

## Security
- API keys must be stored securely (OS keychain or encrypted storage).
- Mask keys in UI; only show last 4.

## Design System Tokens
- Use Tailwind utilities for layout/spacing/typography.
- Keep CSS for branded surfaces and component polish.

