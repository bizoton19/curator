import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("curator", {
  openWorkspace: () => ipcRenderer.invoke("fs:openWorkspace"),
  listWorkspaces: () => ipcRenderer.invoke("fs:listWorkspaces"),
  openWorkspaceAtPath: (payload: { path: string }) =>
    ipcRenderer.invoke("fs:openWorkspaceAtPath", payload),
  addWorkspaceFromDialog: () => ipcRenderer.invoke("fs:addWorkspaceFromDialog"),
  setActiveWorkspace: (payload: { id: string }) =>
    ipcRenderer.invoke("fs:setActiveWorkspace", payload),
  saveWorkspaceFile: (payload: {
    root: string;
    id: "baseline" | "requirements" | "tasks";
    contents: string;
  }) => ipcRenderer.invoke("fs:saveWorkspaceFile", payload),
  importContextFile: (payload: { root: string; sourcePath: string }) =>
    ipcRenderer.invoke("fs:importContextFile", payload),
  importTemplateFile: (payload: { root: string; sourcePath: string }) =>
    ipcRenderer.invoke("fs:importTemplateFile", payload),
  selectTemplateFiles: (payload: { root: string }) =>
    ipcRenderer.invoke("fs:selectTemplateFiles", payload),
  createTextFile: (payload: {
    root: string;
    name: string;
    contents: string;
  }) => ipcRenderer.invoke("fs:createTextFile", payload),
  copyTemplateToDocx: (payload: {
    root: string;
    templatePath: string;
    outputName: string;
  }) => ipcRenderer.invoke("fs:copyTemplateToDocx", payload),
  openPath: (payload: { path: string }) =>
    ipcRenderer.invoke("fs:openPath", payload),
  configGet: () => ipcRenderer.invoke("config:get"),
  configSet: (payload: { provider?: string; model?: string; apiKey?: string }) =>
    ipcRenderer.invoke("config:set", payload),
  closeWindow: () => ipcRenderer.invoke("app:closeWindow"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  createContextDocument: (payload: {
    root: string;
    name: string;
    contents: string;
  }) => ipcRenderer.invoke("fs:createContextDocument", payload),
  readTextFile: (payload: { root: string; path: string }) =>
    ipcRenderer.invoke("fs:readTextFile", payload),
  saveTextFile: (payload: { root: string; path: string; contents: string }) =>
    ipcRenderer.invoke("fs:saveTextFile", payload),
  selectContextFiles: (payload: { root: string }) =>
    ipcRenderer.invoke("fs:selectContextFiles", payload),
  requestPermission: (request: {
    resource: string;
    action: string;
    rationale: string;
  }) => ipcRenderer.invoke("permissions:request", request),
  createTrainingWorkspace: (payload: {
    baseline: string;
    requirements: string;
    tasks: string;
    contextDocuments: { name: string; contents: string }[];
    costEstimate: string;
  }) => ipcRenderer.invoke("fs:createTrainingWorkspace", payload),
  createWorkspace: (payload: { name: string }) => ipcRenderer.invoke("fs:createWorkspace", payload),
  dbSaveMessage: (payload: { workspacePath: string; role: string; text: string }) =>
    ipcRenderer.invoke("db:saveMessage", payload),
  dbGetMessages: (payload: { workspacePath: string }) =>
    ipcRenderer.invoke("db:getMessages", payload),
  dbSaveSnapshot: (payload: { workspacePath: string; fileId: string; content: string }) =>
    ipcRenderer.invoke("db:saveSnapshot", payload),
  dbGetSnapshots: (payload: { workspacePath: string; fileId: string }) =>
    ipcRenderer.invoke("db:getSnapshots", payload),
  dbSetLastOpened: (payload: { workspacePath: string; fileId: string }) =>
    ipcRenderer.invoke("db:setLastOpened", payload),
  dbGetLastOpened: (payload: { workspacePath: string }) =>
    ipcRenderer.invoke("db:getLastOpened", payload)
});
