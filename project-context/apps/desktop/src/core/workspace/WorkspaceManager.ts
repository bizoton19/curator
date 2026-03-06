export const WORKSPACE_FILE_ORDER = [
  "baseline",
  "requirements",
  "tasks"
] as const;

export type WorkspaceFileId = (typeof WORKSPACE_FILE_ORDER)[number];

export type WorkspaceFile = {
  id: WorkspaceFileId;
  path: string;
  contents: string;
};

export type WorkspaceSupplementalFile = {
  name: string;
  path: string;
  ext: string;
};

export type Workspace = {
  id?: string | null;
  name?: string;
  root: string;
  files: Record<WorkspaceFileId, WorkspaceFile>;
  missing: WorkspaceFileId[];
  markdownFiles: WorkspaceSupplementalFile[];
  contextDocuments: WorkspaceSupplementalFile[];
  templates: WorkspaceSupplementalFile[];
};

export class WorkspaceManager {
  async openWorkspace(): Promise<Workspace> {
    const result = await window.curator?.openWorkspace?.();
    if (!result) throw new Error("No workspace selected");
    return result;
  }

  async listWorkspaces(): Promise<{
    root: string;
    workspaces: { id: string; name: string; path: string }[];
    activeId: string | null;
  }> {
    const result = await window.curator?.listWorkspaces?.();
    if (!result) {
      throw new Error("Workspace list unavailable");
    }
    return result;
  }

  async openWorkspaceAtPath(path: string): Promise<Workspace> {
    const result = await window.curator?.openWorkspaceAtPath?.({ path });
    if (!result) throw new Error("Workspace unavailable");
    return result;
  }

  async addWorkspaceFromDialog(): Promise<
    { id: string; name: string; path: string } | null
  > {
    if (!window.curator?.addWorkspaceFromDialog) {
      throw new Error("Workspace picker unavailable");
    }
    return window.curator.addWorkspaceFromDialog();
  }

  async setActiveWorkspace(id: string): Promise<void> {
    if (!window.curator?.setActiveWorkspace) return;
    await window.curator.setActiveWorkspace({ id });
  }

  async saveWorkspaceFile(
    workspace: Workspace,
    fileId: WorkspaceFileId,
    contents: string
  ): Promise<WorkspaceFile> {
    if (!window.curator?.saveWorkspaceFile) {
      throw new Error("Workspace save is not available");
    }
    return window.curator.saveWorkspaceFile({
      root: workspace.root,
      id: fileId,
      contents
    });
  }

  async importContextFile(
    workspace: Workspace,
    sourcePath: string
  ): Promise<WorkspaceSupplementalFile> {
    if (!window.curator?.importContextFile) {
      throw new Error("Workspace imports are not available");
    }
    return window.curator.importContextFile({
      root: workspace.root,
      sourcePath
    });
  }

  async importTemplateFile(
    workspace: Workspace,
    sourcePath: string
  ): Promise<WorkspaceSupplementalFile> {
    if (!window.curator?.importTemplateFile) {
      throw new Error("Workspace imports are not available");
    }
    return window.curator.importTemplateFile({
      root: workspace.root,
      sourcePath
    });
  }

  async selectTemplateFiles(
    workspace: Workspace
  ): Promise<WorkspaceSupplementalFile[]> {
    if (!window.curator?.selectTemplateFiles) {
      throw new Error("Workspace imports are not available");
    }
    return window.curator.selectTemplateFiles({
      root: workspace.root
    });
  }

  async createContextDocument(
    workspace: Workspace,
    name: string,
    contents: string
  ): Promise<WorkspaceSupplementalFile> {
    if (!window.curator?.createContextDocument) {
      throw new Error("Workspace creation is not available");
    }
    return window.curator.createContextDocument({
      root: workspace.root,
      name,
      contents
    });
  }

  async selectContextFiles(
    workspace: Workspace
  ): Promise<WorkspaceSupplementalFile[]> {
    if (!window.curator?.selectContextFiles) {
      throw new Error("Workspace imports are not available");
    }
    return window.curator.selectContextFiles({
      root: workspace.root
    });
  }

  async readTextFile(
    workspace: Workspace,
    path: string
  ): Promise<{ path: string; contents: string; ext: string }> {
    if (!window.curator?.readTextFile) {
      throw new Error("File reader is not available");
    }
    return window.curator.readTextFile({
      root: workspace.root,
      path
    });
  }

  async saveTextFile(
    workspace: Workspace,
    path: string,
    contents: string
  ): Promise<{ path: string; contents: string; ext: string }> {
    if (!window.curator?.saveTextFile) {
      throw new Error("File save is not available");
    }
    return window.curator.saveTextFile({
      root: workspace.root,
      path,
      contents
    });
  }

  async createTextFile(
    workspace: Workspace,
    name: string,
    contents: string
  ): Promise<WorkspaceSupplementalFile> {
    if (!window.curator?.createTextFile) {
      throw new Error("File creation is not available");
    }
    return window.curator.createTextFile({
      root: workspace.root,
      name,
      contents
    });
  }

  async copyTemplateToDocx(
    workspace: Workspace,
    templatePath: string,
    outputName: string
  ): Promise<{ path: string }> {
    if (!window.curator?.copyTemplateToDocx) {
      throw new Error("DOCX generation is not available");
    }
    return window.curator.copyTemplateToDocx({
      root: workspace.root,
      templatePath,
      outputName
    });
  }

  async openPath(path: string): Promise<void> {
    if (!window.curator?.openPath) {
      throw new Error("Open path is not available");
    }
    await window.curator.openPath({ path });
  }
}
