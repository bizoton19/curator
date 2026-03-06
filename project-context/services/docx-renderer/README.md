# DOCX Renderer Service

Local .NET Minimal API for Markdown → DOCX rendering.

## Endpoints
- `GET /health`
- `POST /render/plain`
- `POST /render/template`

## Notes
- This is a stub service. Integrate Open XML SDK or OfficeIMO to generate DOCX files.
- Consider locking down access to localhost only.
