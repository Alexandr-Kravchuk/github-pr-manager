import { contextBridge, ipcRenderer } from "electron";

import type { DashboardResponse, PrManagerApi, UpdateStatus } from "../shared/types";

const api: PrManagerApi = {
  getDashboard: () => ipcRenderer.invoke("dashboard:get"),
  refresh: () => ipcRenderer.invoke("dashboard:refresh"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  markSeen: (items) => ipcRenderer.invoke("seen:mark", items),
  setIgnored: (id, ignored) => ipcRenderer.invoke("ignored:set", id, ignored),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setTheme: (theme) => ipcRenderer.invoke("theme:set", theme),
  getGhStatus: () => ipcRenderer.invoke("gh:status"),
  getJiraStatus: () => ipcRenderer.invoke("jira:status"),
  setJiraToken: (token) => ipcRenderer.invoke("jira:setToken", token),
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  getWhatsNew: () => ipcRenderer.invoke("app:getWhatsNew"),
  dismissWhatsNew: () => ipcRenderer.invoke("app:dismissWhatsNew"),
  copyText: (text) => ipcRenderer.invoke("app:copyText", text),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DashboardResponse) =>
      listener(payload);
    ipcRenderer.on("snapshot", handler);
    return () => {
      ipcRenderer.removeListener("snapshot", handler);
    };
  },
  onConfigError: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on("config-error", handler);
    return () => {
      ipcRenderer.removeListener("config-error", handler);
    };
  },
  onUpdateStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on("update-status", handler);
    return () => {
      ipcRenderer.removeListener("update-status", handler);
    };
  },
};

contextBridge.exposeInMainWorld("api", api);
