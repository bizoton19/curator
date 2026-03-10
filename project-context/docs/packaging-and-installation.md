# Packaging & Installation

This guide covers how to package the Electron desktop app and what users should expect during install, first launch, and ongoing configuration.

## Packaging Overview

Packaging is not wired yet. The current repo builds the renderer and main process (`npm run build`), but does not create installers. The recommended approach is to use `electron-builder` (or Electron Forge) and bundle the .NET DOCX renderer as a packaged resource.

## Easiest Distribution (GitHub Releases)

Use GitHub Releases as the download host for macOS and Windows installers.

### One-time setup
1. Ensure the repo has a GitHub remote (required for releases).
2. Add the GitHub Actions workflow in `.github/workflows/release.yml` (already included in this repo).
3. Add `electron-builder` config in `apps/desktop/package.json` (already included).

### Release steps (maintainers)
1. Update the app version in `apps/desktop/package.json` in the PR.
2. Merge the PR into `main`.
3. GitHub Actions will:
   - Create a tag `vX.Y.Z` if it does not exist
   - Build macOS + Windows installers
   - Attach assets to a GitHub Release
4. GitHub Actions will build:
   - macOS `.dmg` + `.zip`
   - Windows `.exe` (NSIS) + `.zip`
5. Assets are attached to the GitHub Release automatically.

### Download steps (end users)
1. Open the GitHub Release page.
2. Download the macOS `.dmg` or Windows `.exe`.
3. Install as normal.

## Recommended Packaging Steps (electron-builder)

1. Add dependencies and scripts
   - Install `electron-builder` as a dev dependency.
   - Add scripts such as:
     - `dist` (build + package)
     - `dist:mac`, `dist:win` (platform-specific)

2. Add `build` config in `apps/desktop/package.json`
   - Define `appId`, `productName`, output folders, and file patterns.
   - Include the compiled main/renderer output and preload:
     - `dist/main/**`
     - `dist/renderer/**`
   - Include static assets and icons.
   - For DOCX rendering, add the .NET executable to `extraResources`.

3. Build the app
   - `npm run build` produces:
     - `dist/main` (Electron main)
     - `dist/renderer` (Vite renderer)

4. Package
   - `npm run dist`
   - Outputs:
     - macOS `.dmg` (and `.zip`)
     - Windows `.exe` or `.msi` (depending on config)

5. Signing and notarization
   - macOS: Sign and notarize to avoid Gatekeeper prompts.
   - Windows: Code-sign the installer to reduce SmartScreen warnings.

## Installation (End Users)

### macOS
1. Open the `.dmg`.
2. Drag the app into `Applications`.
3. Launch the app.
4. If prompted by Gatekeeper, choose **Open** in System Settings > Privacy & Security.

### Windows
1. Run the installer (`.exe` or `.msi`).
2. Follow the install wizard.
3. Launch the app from the Start Menu.

## First Launch Behavior

On first launch:
- A default workspace is created at:
  - macOS: `~/curator-workspaces`
  - Windows: `%USERPROFILE%\\curator-workspaces`
- The app creates:
  - `baseline.md`, `requirements.md`, `tasks.md`
  - `context-documents/`
  - `templates/`
- The user can start immediately without selecting a workspace.

## Configuration & Settings

### During install
There is no installer-time configuration yet. If IT needs a preconfigured setup:
- Pre-seed the config file in the user data directory before first launch.
- Optional: pre-create workspace folders and templates.

### After install (in-app)
The app has a **Settings** panel with:
- Provider selection (OpenAI / Anthropic / Azure OpenAI / OpenRouter)
- Model selection
- API key entry (stored securely)

Storage details:
- Config file: `app.getPath("userData")/config.json`
- API key: stored with Electron `safeStorage` encryption
- Registry file: `app.getPath("userData")/registry.json`

### Resetting configuration
If a user needs a reset:
- Delete `config.json` (and optionally `registry.json`) under the user data path.
- The app will recreate defaults on next launch.

## Updates

When a new version is installed:
- User data is preserved in `userData`.
- Workspaces under `~/curator-workspaces` remain intact.
- If settings migration is needed, add a lightweight migration step in the main process on launch.

## Signing & Notarization (Placeholder)

To avoid security warnings on user machines:
- macOS: sign and notarize the app
- Windows: code-sign the installer

Typical env vars for `electron-builder` (store as GitHub Secrets):
- `CSC_LINK` / `CSC_KEY_PASSWORD` for signing
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization

## Bundling the .NET DOCX Renderer

The release pipeline publishes the .NET Minimal API and bundles it inside the app:
- Build step: `dotnet publish services/docx-renderer -c Release -o services/docx-renderer/publish`
- `electron-builder` pulls the bundle from `services/docx-renderer/publish`
- At runtime, the app can launch the bundled renderer from `resources/docx-renderer`
