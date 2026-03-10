import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage
} from "electron";
import type { MessageBoxOptions } from "electron";
import { basename, dirname, extname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile
} from "fs/promises";
import { SearchIndex } from "./search/SearchIndex.js";

import { DatabaseManager } from "./db.js";

/** Lazy-load conversion to avoid pulling pdf-parse/pdfjs-dist at main process startup (they need DOM/canvas). */
const convertToMarkdownLazy = async (filePath: string): Promise<string> => {
  const { convertToMarkdown } = await import("./convertToMarkdown.js");
  return convertToMarkdown(filePath);
};

const isDev = process.env.NODE_ENV !== "production";
const WORKSPACE_FILES = ["baseline", "requirements", "tasks"] as const;
const dbManager = new DatabaseManager();
type WorkspaceFileId = (typeof WORKSPACE_FILES)[number];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTEXT_DIR = "context-documents";
const CONVERTED_DIR = ".curator-converted";
const TEMPLATE_DIR = "templates";
const WORKSPACES_FOLDER = "workspaces";
const CONTEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".log",
  ".env",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".sql",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".php",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".ps1",
  ".sh",
  ".docx",
  ".pdf",
  ".pptx",
  ".xlsx"
]);
const CONTEXT_EXTENSIONS_NEED_CONVERSION = new Set([
  ".docx",
  ".pdf",
  ".pptx",
  ".xlsx"
]);
const MAX_CONTEXT_DOCUMENTS = 10;
const TEMPLATE_EXTENSIONS = new Set([".docx", ".dot"]);
const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_WORKSPACE_NAME = "Default Workspace";
let didForceReload = false;

type WorkspaceEntry = { id: string; name: string; path: string };
type WorkspaceRegistry = { workspaces: WorkspaceEntry[]; activeId: string | null };

let workspaceRootPath = "";
let registryPath = "";
let configPath = "";
let searchIndex: SearchIndex | null = null;

type StoredConfig = {
  provider?: string;
  model?: string;
  apiKeyEncrypted?: string;
  defaultWorkspaceReady?: boolean;
  lastOpenedByWorkspace?: Record<
    string,
    { kind: "core"; id: WorkspaceFileId } | { kind: "supplemental"; path: string }
  >;
};

const sanitizeFilename = (name: string) =>
  name
    .trim()
    .replace(/[\\/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 120);

const isPathInsideRoot = (root: string, target: string) => {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  );
};

const listFolder = async (dir: string, allowed?: Set<string>) => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const ext = extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          path: join(dir, entry.name),
          ext
        };
      })
      .filter((entry) => (allowed ? allowed.has(entry.ext) : true))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    return [];
  }
};

const getSidecarPath = (originalPath: string) => {
  const dir = dirname(originalPath);
  const base = basename(originalPath);
  return join(dir, CONVERTED_DIR, `${base}.md`);
};

const formatConversionFailure = (path: string, error: unknown) => {
  const reason = error instanceof Error ? error.message : "Unknown error";
  console.error(`Failed to convert context document: ${path}`, error);
  return `Conversion failed for ${basename(path)}.\n\n${reason}`;
};

const importContextFileInternal = async (root: string, sourcePath: string) => {
  const ext = extname(sourcePath).toLowerCase();
  if (!CONTEXT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported context file type: ${ext || "unknown"}`);
  }
  const targetDir = join(root, CONTEXT_DIR);
  await ensureDir(targetDir);
  const targetPath = await findAvailablePath(targetDir, basename(sourcePath));
  await copyFile(sourcePath, targetPath);
  if (CONTEXT_EXTENSIONS_NEED_CONVERSION.has(ext)) {
    const convertedDir = join(targetDir, CONVERTED_DIR);
    await ensureDir(convertedDir);
    // Convert in the background so multi-file uploads return quickly.
    void (async () => {
      try {
        const markdown = await convertToMarkdownLazy(targetPath);
        const sidecarPath = getSidecarPath(targetPath);
        await writeFile(sidecarPath, markdown, "utf-8");
      } catch (error) {
        const sidecarPath = getSidecarPath(targetPath);
        await writeFile(
          sidecarPath,
          formatConversionFailure(targetPath, error),
          "utf-8"
        );
      } finally {
        if (searchIndex) {
          try {
            await searchIndex.indexFile(targetPath, CONTEXT_EXTENSIONS);
          } catch (error) {
            console.error("Search indexing failed:", error);
          }
        }
      }
    })();
  } else if (searchIndex) {
    try {
      await searchIndex.indexFile(targetPath, CONTEXT_EXTENSIONS);
    } catch (error) {
      console.error("Search indexing failed:", error);
    }
  }
  return { name: basename(targetPath), path: targetPath, ext };
};

const importTemplateFileInternal = async (root: string, sourcePath: string) => {
  const ext = extname(sourcePath).toLowerCase();
  if (!TEMPLATE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported template file type: ${ext || "unknown"}`);
  }
  const targetDir = join(root, TEMPLATE_DIR);
  await ensureDir(targetDir);
  const targetPath = await findAvailablePath(targetDir, basename(sourcePath));
  await copyFile(sourcePath, targetPath);
  return { name: basename(targetPath), path: targetPath, ext };
};

const ensureDir = async (dir: string) => {
  await mkdir(dir, { recursive: true });
};

const ensureFile = async (path: string, contents: string) => {
  try {
    await stat(path);
  } catch {
    await writeFile(path, contents, "utf-8");
  }
};

const findAvailablePath = async (dir: string, filename: string) => {
  const ext = extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = join(dir, filename);
  let index = 1;
  while (true) {
    try {
      await stat(candidate);
      candidate = join(dir, `${base}-${index}${ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
};

const createTextFileInternal = async (
  root: string,
  name: string,
  contents: string
) => {
  const safeName = sanitizeFilename(name);
  if (!safeName) {
    throw new Error("Invalid file name");
  }
  const ext = extname(safeName).toLowerCase() || ".md";
  if (!CONTEXT_EXTENSIONS.has(ext) && ext !== ".md") {
    throw new Error(`Unsupported file type: ${ext}`);
  }
  const filename = safeName.endsWith(ext) ? safeName : `${safeName}${ext}`;
  const targetPath = await findAvailablePath(root, filename);
  await writeFile(targetPath, contents, "utf-8");
  if (searchIndex) {
    try {
      await searchIndex.indexFile(targetPath, CONTEXT_EXTENSIONS);
    } catch (error) {
      console.error("Search indexing failed:", error);
    }
  }
  return { name: basename(targetPath), path: targetPath, ext };
};

const loadRegistry = async (): Promise<WorkspaceRegistry> => {
  if (!registryPath) {
    return { workspaces: [], activeId: null };
  }
  try {
    const raw = await readFile(registryPath, "utf-8");
    const parsed = JSON.parse(raw) as WorkspaceRegistry;
    return {
      workspaces: parsed.workspaces ?? [],
      activeId: parsed.activeId ?? null
    };
  } catch {
    return { workspaces: [], activeId: null };
  }
};

const loadConfig = async (): Promise<StoredConfig> => {
  if (!configPath) return {};
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return {};
  }
};

const saveConfig = async (config: StoredConfig) => {
  if (!configPath) return;
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
};

const encryptApiKey = (apiKey: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure storage is not available on this system.");
  }
  return safeStorage.encryptString(apiKey).toString("base64");
};

const decryptApiKey = (encrypted: string) => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure storage is not available on this system.");
  }
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
};

const saveRegistry = async (registry: WorkspaceRegistry) => {
  if (!registryPath) return;
  await ensureDir(workspaceRootPath);
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
};

const createWorkspaceEntry = async (
  id: string,
  name: string,
  root: string
) => {
  await ensureDir(root);
  await ensureDir(join(root, CONTEXT_DIR));
  await ensureDir(join(root, TEMPLATE_DIR));
  await ensureFile(
    join(root, "baseline.md"),
    "# Baseline\n\n## Project Overview\n\n## Scope\n\n## Assumptions\n\n"
  );
  await ensureFile(join(root, "requirements.md"), "# Requirements\n\n");
  await ensureFile(join(root, "tasks.md"), "# Tasks\n\n");
  return { id, name, path: root };
};

const ensureDefaultWorkspace = async () => {
  if (!workspaceRootPath) return;
  await ensureDir(workspaceRootPath);
  const registry = await loadRegistry();
  const existing = registry.workspaces.find(
    (workspace) => workspace.id === DEFAULT_WORKSPACE_ID
  );
  if (!existing) {
    const root = join(workspaceRootPath, DEFAULT_WORKSPACE_ID);
    const entry = await createWorkspaceEntry(
      DEFAULT_WORKSPACE_ID,
      DEFAULT_WORKSPACE_NAME,
      root
    );
    registry.workspaces.push(entry);
  }
  if (!registry.activeId) {
    registry.activeId = DEFAULT_WORKSPACE_ID;
  }
  await saveRegistry(registry);
};

const registerWorkspacePath = async (root: string) => {
  const registry = await loadRegistry();
  const existing = registry.workspaces.find((entry) => entry.path === root);
  if (existing) return existing;
  const name = basename(root);
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  const entry = { id, name, path: root };
  registry.workspaces.push(entry);
  registry.activeId = entry.id;
  await saveRegistry(registry);
  return entry;
};

const openWorkspaceInternal = async (root: string) => {
  await ensureDir(join(root, CONTEXT_DIR));
  await ensureDir(join(root, TEMPLATE_DIR));
  const files: Record<
    WorkspaceFileId,
    { id: WorkspaceFileId; path: string; contents: string }
  > = {} as Record<
    WorkspaceFileId,
    { id: WorkspaceFileId; path: string; contents: string }
  >;
  const missing: WorkspaceFileId[] = [];

  for (const id of WORKSPACE_FILES) {
    const path = join(root, `${id}.md`);
    try {
      const contents = await readFile(path, "utf-8");
      files[id] = { id, path, contents };
    } catch {
      missing.push(id);
      files[id] = { id, path, contents: "" };
    }
  }

  const markdownFiles = await listFolder(root);
  const extraMarkdown = markdownFiles.filter((file) => {
    if (file.ext !== ".md") return false;
    const name = file.name.toLowerCase();
    return !WORKSPACE_FILES.some((id) => `${id}.md` === name);
  });
  const contextDocuments = await listFolder(
    join(root, CONTEXT_DIR),
    CONTEXT_EXTENSIONS
  );
  const templates = await listFolder(join(root, TEMPLATE_DIR), TEMPLATE_EXTENSIONS);
  const registry = await loadRegistry();
  const entry = registry.workspaces.find((workspace) => workspace.path === root);

  if (searchIndex) {
    searchIndex.indexWorkspace(root, CONTEXT_EXTENSIONS).catch((error: unknown) => {
      console.error("Search indexing failed:", error);
    });
  }

  return {
    root,
    id: entry?.id ?? null,
    name: entry?.name ?? basename(root),
    files,
    missing,
    markdownFiles: extraMarkdown,
    contextDocuments,
    templates
  };
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    win.loadURL("http://localhost:5175");
    win.webContents.openDevTools({ mode: "detach" });
    win.webContents.on("did-finish-load", async () => {
      if (didForceReload) return;
      didForceReload = true;
      try {
        await win.webContents.session.clearCache();
        await win.webContents.session.clearStorageData();
      } catch {
        // ignore cache clear errors in dev
      }
      win.webContents.reloadIgnoringCache();
    });
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
};

app.whenReady().then(() => {
  workspaceRootPath = join(app.getPath("home"), "curator-workspaces");
  // Keep registry/config in userData for safety, or move them?
  // Moving registry to the public folder makes it editable by user, which is fine but maybe risky.
  // Let's keep registry in userData but workspaces in home.
  registryPath = join(app.getPath("userData"), "registry.json");
  configPath = join(app.getPath("userData"), "config.json");
  searchIndex = new SearchIndex(join(app.getPath("userData"), "search-index.db"));
  ensureDefaultWorkspace().catch(() => {});
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("fs:openWorkspace", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const root = result.filePaths[0];
  await registerWorkspacePath(root);
  return openWorkspaceInternal(root);
});

ipcMain.handle("fs:openWorkspaceAtPath", async (_event, payload: { path?: string }) => {
  if (!payload?.path) return null;
  await registerWorkspacePath(payload.path);
  return openWorkspaceInternal(payload.path);
});

ipcMain.handle("fs:listWorkspaces", async () => {
  await ensureDefaultWorkspace();
  const registry = await loadRegistry();
  return {
    root: workspaceRootPath,
    workspaces: registry.workspaces,
    activeId: registry.activeId ?? null
  };
});

ipcMain.handle("fs:setActiveWorkspace", async (_event, payload: { id?: string }) => {
  if (!payload?.id) return;
  const registry = await loadRegistry();
  if (registry.activeId === payload.id) return;
  const exists = registry.workspaces.some((entry) => entry.id === payload.id);
  if (!exists) return;
  registry.activeId = payload.id;
  await saveRegistry(registry);
});

ipcMain.handle(
  "search:files",
  async (_event, payload: { root?: string; query?: string; limit?: number }) => {
    if (!payload?.root || !payload?.query) return [];
    if (!searchIndex) return [];
    return searchIndex.searchFiles(
      payload.root,
      payload.query,
      payload.limit ?? 50
    );
  }
);

ipcMain.handle(
  "search:context",
  async (_event, payload: { root?: string; query?: string; limit?: number }) => {
    if (!payload?.root || !payload?.query) return [];
    if (!searchIndex) return [];
    return searchIndex.searchContext(
      payload.root,
      payload.query,
      payload.limit ?? 12
    );
  }
);

ipcMain.handle("fs:createWorkspace", async (_event, payload: { name: string }) => {
  if (!payload?.name) throw new Error("Workspace name is required");
  
  const safeName = sanitizeFilename(payload.name);
  if (!safeName) throw new Error("Invalid workspace name");
  
  if (!workspaceRootPath) {
    throw new Error("Workspace root not initialized");
  }

  const root = join(workspaceRootPath, safeName);
  
  // Check if already exists in registry or fs
  const registry = await loadRegistry();
  const existing = registry.workspaces.find(
    (w) => w.path === root || w.name.toLowerCase() === payload.name.toLowerCase()
  );
  
  if (existing) {
    // If it exists, just open it
    return openWorkspaceInternal(existing.path);
  }
  
  // Create it
  try {
    await ensureDir(root);
    const id = `${safeName.toLowerCase()}-${Date.now()}`;
    const entry = await createWorkspaceEntry(id, payload.name, root);
    
    registry.workspaces.push(entry);
    registry.activeId = entry.id;
    await saveRegistry(registry);
    
    return openWorkspaceInternal(root);
  } catch (error) {
    throw new Error(`Failed to create workspace: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
});

ipcMain.handle("fs:addWorkspaceFromDialog", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const root = result.filePaths[0];
  return registerWorkspacePath(root);
});

const TRAINING_WORKSPACE_ID = "training";
const TRAINING_WORKSPACE_NAME = "Training Workspace";

ipcMain.handle(
  "fs:createTrainingWorkspace",
  async (
    _event,
    payload: {
      baseline?: string;
      requirements?: string;
      tasks?: string;
      contextDocuments?: { name: string; contents: string }[];
      costEstimate?: string;
    }
  ) => {
    if (!workspaceRootPath) {
      throw new Error("Workspace root not initialized");
    }
    
    const root = join(workspaceRootPath, TRAINING_WORKSPACE_ID);
    
    await ensureDir(root);
    await ensureDir(join(root, CONTEXT_DIR));
    await ensureDir(join(root, TEMPLATE_DIR));
    
    await writeFile(
      join(root, "baseline.md"),
      payload?.baseline || "# Baseline\n\n",
      "utf-8"
    );
    await writeFile(
      join(root, "requirements.md"),
      payload?.requirements || "# Requirements\n\n",
      "utf-8"
    );
    await writeFile(
      join(root, "tasks.md"),
      payload?.tasks || "# Tasks\n\n",
      "utf-8"
    );
    
    if (payload?.contextDocuments) {
      for (const doc of payload.contextDocuments) {
        const safeName = sanitizeFilename(doc.name) || "context-doc.md";
        const targetPath = join(root, CONTEXT_DIR, safeName);
        await writeFile(targetPath, doc.contents, "utf-8");
      }
    }
    
    if (payload?.costEstimate) {
      await writeFile(
        join(root, "cost-estimate.md"),
        payload.costEstimate,
        "utf-8"
      );
    }
    
    const registry = await loadRegistry();
    const existing = registry.workspaces.find(
      (workspace) => workspace.id === TRAINING_WORKSPACE_ID
    );
    if (!existing) {
      registry.workspaces.push({
        id: TRAINING_WORKSPACE_ID,
        name: TRAINING_WORKSPACE_NAME,
        path: root
      });
    }
    registry.activeId = TRAINING_WORKSPACE_ID;
    await saveRegistry(registry);
    
    return openWorkspaceInternal(root);
  }
);

ipcMain.handle(
  "fs:saveWorkspaceFile",
  async (
    _event,
    payload: { root?: string; id?: WorkspaceFileId; contents?: string }
  ) => {
    if (!payload?.root || !payload?.id) {
      throw new Error("Invalid workspace file payload");
    }
    const path = join(payload.root, `${payload.id}.md`);
    const contents = payload.contents ?? "";
    await writeFile(path, contents, "utf-8");
    if (searchIndex) {
      try {
        await searchIndex.indexFile(path, CONTEXT_EXTENSIONS);
      } catch (error) {
        console.error("Search indexing failed:", error);
      }
    }
    return { id: payload.id, path, contents };
  }
);

ipcMain.handle(
  "fs:readTextFile",
  async (_event, payload: { root?: string; path?: string }) => {
    if (!payload?.root || !payload?.path) {
      throw new Error("Invalid read payload");
    }
    if (!isPathInsideRoot(payload.root, payload.path)) {
      throw new Error("File access outside workspace root is not allowed");
    }
    const ext = extname(payload.path).toLowerCase();
    if (!CONTEXT_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type: ${ext || "unknown"}`);
    }
    if (
      isPathInsideRoot(join(payload.root, CONTEXT_DIR), payload.path) &&
      CONTEXT_EXTENSIONS_NEED_CONVERSION.has(ext)
    ) {
      const sidecarPath = getSidecarPath(payload.path);
      try {
        const contents = await readFile(sidecarPath, "utf-8");
        return { path: payload.path, contents, ext };
      } catch {
        try {
          const markdown = await convertToMarkdownLazy(payload.path);
          await ensureDir(dirname(sidecarPath));
          await writeFile(sidecarPath, markdown, "utf-8");
          if (searchIndex) {
            try {
              await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
            } catch (error) {
              console.error("Search indexing failed:", error);
            }
          }
          return { path: payload.path, contents: markdown, ext };
        } catch (error) {
          const contents = formatConversionFailure(payload.path, error);
          await ensureDir(dirname(sidecarPath));
          await writeFile(sidecarPath, contents, "utf-8");
          if (searchIndex) {
            try {
              await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
            } catch (err) {
              console.error("Search indexing failed:", err);
            }
          }
          return {
            path: payload.path,
            contents,
            ext
          };
        }
      }
    }
    const contents = await readFile(payload.path, "utf-8");
    if (searchIndex) {
      try {
        await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
      } catch (error) {
        console.error("Search indexing failed:", error);
      }
    }
    return { path: payload.path, contents, ext };
  }
);

ipcMain.handle(
  "fs:getContextDocumentContent",
  async (_event, payload: { root?: string; path?: string }) => {
    if (!payload?.root || !payload?.path) {
      throw new Error("Invalid getContextDocumentContent payload");
    }
    if (!isPathInsideRoot(payload.root, payload.path)) {
      throw new Error("File access outside workspace root is not allowed");
    }
    const contextDirAbs = join(payload.root, CONTEXT_DIR);
    if (!isPathInsideRoot(contextDirAbs, payload.path)) {
      throw new Error("Path is not a context document");
    }
    const ext = extname(payload.path).toLowerCase();
    if (!CONTEXT_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type: ${ext || "unknown"}`);
    }
    if (CONTEXT_EXTENSIONS_NEED_CONVERSION.has(ext)) {
      const sidecarPath = getSidecarPath(payload.path);
      try {
        const contents = await readFile(sidecarPath, "utf-8");
        return { path: payload.path, contents, ext };
      } catch {
        try {
          const markdown = await convertToMarkdownLazy(payload.path);
          await ensureDir(dirname(sidecarPath));
          await writeFile(sidecarPath, markdown, "utf-8");
          if (searchIndex) {
            try {
              await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
            } catch (error) {
              console.error("Search indexing failed:", error);
            }
          }
          return { path: payload.path, contents: markdown, ext };
        } catch (error) {
          const contents = formatConversionFailure(payload.path, error);
          await ensureDir(dirname(sidecarPath));
          await writeFile(sidecarPath, contents, "utf-8");
          if (searchIndex) {
            try {
              await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
            } catch (err) {
              console.error("Search indexing failed:", err);
            }
          }
          return {
            path: payload.path,
            contents,
            ext
          };
        }
      }
    }
    const contents = await readFile(payload.path, "utf-8");
    if (searchIndex) {
      try {
        await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
      } catch (error) {
        console.error("Search indexing failed:", error);
      }
    }
    return { path: payload.path, contents, ext };
  }
);

ipcMain.handle(
  "fs:saveTextFile",
  async (
    _event,
    payload: { root?: string; path?: string; contents?: string }
  ) => {
    if (!payload?.root || !payload?.path) {
      throw new Error("Invalid save payload");
    }
    if (!isPathInsideRoot(payload.root, payload.path)) {
      throw new Error("File access outside workspace root is not allowed");
    }
    const ext = extname(payload.path).toLowerCase();
    if (!CONTEXT_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported file type: ${ext || "unknown"}`);
    }
    const contents = payload.contents ?? "";
    const contextDirAbs = join(payload.root, CONTEXT_DIR);
    const isConvertedContextDoc =
      isPathInsideRoot(contextDirAbs, payload.path) &&
      CONTEXT_EXTENSIONS_NEED_CONVERSION.has(ext);
    const writePath = isConvertedContextDoc
      ? getSidecarPath(payload.path)
      : payload.path;
    await ensureDir(dirname(writePath));
    await writeFile(writePath, contents, "utf-8");
    if (searchIndex) {
      try {
        await searchIndex.indexFile(payload.path, CONTEXT_EXTENSIONS);
      } catch (error) {
        console.error("Search indexing failed:", error);
      }
    }
    return { path: payload.path, contents, ext };
  }
);

ipcMain.handle(
  "fs:createContextDocument",
  async (
    _event,
    payload: { root?: string; name?: string; contents?: string }
  ) => {
    if (!payload?.root || !payload?.name) {
      throw new Error("Invalid context document payload");
    }
    const existing = await listFolder(
      join(payload.root, CONTEXT_DIR),
      CONTEXT_EXTENSIONS
    );
    if (existing.length >= MAX_CONTEXT_DOCUMENTS) {
      throw new Error(
        `Maximum ${MAX_CONTEXT_DOCUMENTS} supporting documents. Remove one to add another.`
      );
    }
    const targetDir = join(payload.root, CONTEXT_DIR);
    await ensureDir(targetDir);
    const safeName = sanitizeFilename(payload.name) || "context-notes";
    const ext = extname(safeName).toLowerCase() || ".md";
    if (!CONTEXT_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported context file type: ${ext}`);
    }
    const filename = safeName.endsWith(ext) ? safeName : `${safeName}${ext}`;
    const targetPath = await findAvailablePath(targetDir, filename);
    const contents = payload.contents ?? "";
    await writeFile(targetPath, contents, "utf-8");
    if (searchIndex) {
      try {
        await searchIndex.indexFile(targetPath, CONTEXT_EXTENSIONS);
      } catch (error) {
        console.error("Search indexing failed:", error);
      }
    }
    return { name: basename(targetPath), path: targetPath, ext };
  }
);

ipcMain.handle(
  "fs:importContextFile",
  async (_event, payload: { root?: string; sourcePath?: string }) => {
    if (!payload?.root || !payload?.sourcePath) {
      throw new Error("Invalid context import payload");
    }
    const existing = await listFolder(
      join(payload.root, CONTEXT_DIR),
      CONTEXT_EXTENSIONS
    );
    if (existing.length >= MAX_CONTEXT_DOCUMENTS) {
      throw new Error(
        `Maximum ${MAX_CONTEXT_DOCUMENTS} supporting documents. Remove one to add another.`
      );
    }
    return importContextFileInternal(payload.root, payload.sourcePath);
  }
);

ipcMain.handle(
  "fs:selectContextFiles",
  async (_event, payload: { root?: string }) => {
    if (!payload?.root) {
      throw new Error("Invalid context import payload");
    }
    const existing = await listFolder(
      join(payload.root, CONTEXT_DIR),
      CONTEXT_EXTENSIONS
    );
    const remaining = Math.max(0, MAX_CONTEXT_DOCUMENTS - existing.length);
    if (remaining === 0) {
      return [];
    }
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Context Documents",
          extensions: Array.from(CONTEXT_EXTENSIONS).map((ext) =>
            ext.replace(".", "")
          )
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    const imported: { name: string; path: string; ext: string }[] = [];
    const toImport = result.filePaths.slice(0, remaining);
    for (const sourcePath of toImport) {
      try {
        const saved = await importContextFileInternal(payload.root, sourcePath);
        imported.push(saved);
        if (imported.length >= remaining) break;
      } catch (error) {
        continue;
      }
    }
    return imported;
  }
);

ipcMain.handle(
  "fs:selectTemplateFiles",
  async (_event, payload: { root?: string }) => {
    if (!payload?.root) {
      throw new Error("Invalid template import payload");
    }
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Templates",
          extensions: Array.from(TEMPLATE_EXTENSIONS).map((ext) =>
            ext.replace(".", "")
          )
        }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    const imported: { name: string; path: string; ext: string }[] = [];
    for (const sourcePath of result.filePaths) {
      try {
        const saved = await importTemplateFileInternal(
          payload.root,
          sourcePath
        );
        imported.push(saved);
      } catch {
        continue;
      }
    }
    return imported;
  }
);

ipcMain.handle(
  "fs:importTemplateFile",
  async (_event, payload: { root?: string; sourcePath?: string }) => {
    if (!payload?.root || !payload?.sourcePath) {
      throw new Error("Invalid template import payload");
    }
    return importTemplateFileInternal(payload.root, payload.sourcePath);
  }
);

ipcMain.handle(
  "fs:createTextFile",
  async (
    _event,
    payload: { root?: string; name?: string; contents?: string }
  ) => {
    if (!payload?.root || !payload?.name) {
      throw new Error("Invalid create payload");
    }
    if (!isPathInsideRoot(payload.root, payload.root)) {
      throw new Error("Invalid workspace root");
    }
    return createTextFileInternal(
      payload.root,
      payload.name,
      payload.contents ?? ""
    );
  }
);

ipcMain.handle(
  "fs:copyTemplateToDocx",
  async (
    _event,
    payload: { root?: string; templatePath?: string; outputName?: string }
  ) => {
    if (!payload?.root || !payload?.templatePath || !payload?.outputName) {
      throw new Error("Invalid docx payload");
    }
    if (!isPathInsideRoot(payload.root, payload.templatePath)) {
      throw new Error("Template must be inside the workspace");
    }
    const ext = extname(payload.templatePath).toLowerCase();
    if (!TEMPLATE_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported template type: ${ext || "unknown"}`);
    }
    const output = await findAvailablePath(
      payload.root,
      payload.outputName.endsWith(".docx")
        ? payload.outputName
        : `${payload.outputName}.docx`
    );
    await copyFile(payload.templatePath, output);
    return { path: output };
  }
);

ipcMain.handle(
  "fs:openPath",
  async (_event, payload: { path?: string }) => {
    if (!payload?.path) {
      throw new Error("Invalid path");
    }
    await shell.openPath(payload.path);
    return true;
  }
);

ipcMain.handle("permissions:request", async (_event, request) => {
  const workspacePath = request?.workspacePath;
  const action = request?.action ?? "access";

  if (workspacePath && dbManager.hasPermission(workspacePath, action)) {
    return true;
  }

  const message = "Curator needs permission";
  const detail = request?.rationale ?? "Permission required to proceed.";
  const win = BrowserWindow.getFocusedWindow();
  const options: MessageBoxOptions = {
    type: "question",
    buttons: ["Allow once", "Always allow", "Deny"],
    defaultId: 1,
    cancelId: 2,
    title: "Curator",
    message,
    detail
  };
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (response === 2) {
    return false;
  }

  if (response === 1 && workspacePath) {
    dbManager.grantPermission(workspacePath, action);
  }

  return true;
});

ipcMain.handle("config:get", async () => {
  const config = await loadConfig();
  let apiKeyLast4 = "";
  let hasApiKey = false;
  let apiKey = "";
  if (config.apiKeyEncrypted) {
    try {
      apiKey = decryptApiKey(config.apiKeyEncrypted);
      hasApiKey = true;
      apiKeyLast4 = apiKey.slice(-4);
    } catch {
      hasApiKey = false;
    }
  }
  return {
    provider: config.provider ?? "openrouter",
    model: config.model ?? "openai/gpt-4o-mini",
    hasApiKey,
    apiKeyLast4,
    apiKey,
    defaultWorkspaceReady: config.defaultWorkspaceReady ?? false,
    lastOpenedByWorkspace: config.lastOpenedByWorkspace ?? {}
  };
});

ipcMain.handle(
  "config:set",
  async (
    _event,
    payload: {
      provider?: string;
      model?: string;
      apiKey?: string;
      defaultWorkspaceReady?: boolean;
      lastOpenedByWorkspace?: StoredConfig["lastOpenedByWorkspace"];
    }
  ) => {
    const config = await loadConfig();
    if (payload?.provider) {
      config.provider = payload.provider;
    }
    if (payload?.model) {
      config.model = payload.model;
    }
    if (payload?.apiKey !== undefined) {
      if (payload.apiKey) {
        config.apiKeyEncrypted = encryptApiKey(payload.apiKey);
      } else {
        delete config.apiKeyEncrypted;
      }
    }
    if (payload?.defaultWorkspaceReady !== undefined) {
      config.defaultWorkspaceReady = payload.defaultWorkspaceReady;
    }
    if (payload?.lastOpenedByWorkspace) {
      config.lastOpenedByWorkspace = payload.lastOpenedByWorkspace;
    }
    await saveConfig(config);
    return { success: true };
  }
);

ipcMain.handle("app:closeWindow", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.close();
});

ipcMain.handle("app:quit", () => {
  app.quit();
});

ipcMain.handle("db:saveMessage", (_event, payload: { workspacePath: string; role: string; text: string }) => {
  if (!payload.workspacePath || !payload.role || !payload.text) return;
  return dbManager.saveMessage(payload.workspacePath, payload.role, payload.text);
});

ipcMain.handle("db:getMessages", (_event, payload: { workspacePath: string }) => {
  if (!payload.workspacePath) return [];
  return dbManager.getMessages(payload.workspacePath);
});

ipcMain.handle("db:saveSnapshot", (_event, payload: { workspacePath: string; fileId: string; content: string }) => {
  if (!payload.workspacePath || !payload.fileId) return;
  return dbManager.saveSnapshot(payload.workspacePath, payload.fileId, payload.content || "");
});

ipcMain.handle("db:getSnapshots", (_event, payload: { workspacePath: string; fileId: string }) => {
  if (!payload.workspacePath || !payload.fileId) return [];
  return dbManager.getSnapshots(payload.workspacePath, payload.fileId);
});

ipcMain.handle("db:setLastOpened", (_event, payload: { workspacePath: string; fileId: string }) => {
  if (!payload.workspacePath || !payload.fileId) return;
  return dbManager.setLastOpened(payload.workspacePath, payload.fileId);
});

ipcMain.handle("db:getLastOpened", (_event, payload: { workspacePath: string }) => {
  if (!payload.workspacePath) return null;
  return dbManager.getLastOpened(payload.workspacePath);
});
