import { contextBridge, ipcRenderer } from "electron";

import type { AgentState, ClaudeSessionInfo, DashboardResponse, PrManagerApi, UpdateStatus } from "../shared/types";

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
  setUiStyle: (style) => ipcRenderer.invoke("style:set", style),
  getGhStatus: () => ipcRenderer.invoke("gh:status"),
  getJiraStatus: (mode) => ipcRenderer.invoke("jira:status", mode),
  setJiraToken: (token) => ipcRenderer.invoke("jira:setToken", token),
  twgLogin: () => ipcRenderer.invoke("jira:twgLogin"),
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  getWhatsNew: () => ipcRenderer.invoke("app:getWhatsNew"),
  dismissWhatsNew: () => ipcRenderer.invoke("app:dismissWhatsNew"),
  launchClaude: (prId, kind, inTerminal) => ipcRenderer.invoke("claude:launch", prId, kind, inTerminal),
  launchClaudeGroup: (kind, groupKey, prIds) => ipcRenderer.invoke("claude:launchGroup", kind, groupKey, prIds),
  getClaudeSessions: () => ipcRenderer.invoke("claude:sessions"),
  focusClaudeSession: (sessionId) => ipcRenderer.invoke("claude:focusSession", sessionId),
  getAgentState: () => ipcRenderer.invoke("agent:get"),
  agentAction: (action) => ipcRenderer.invoke("agent:action", action),
  revealAgentLog: () => ipcRenderer.invoke("agent:revealLog"),
  onCheckDiagrams: (listener) => {
    const handler = (_e: unknown, raw: unknown) => {
      const r = (typeof raw === "object" && raw !== null ? raw : {}) as { requestId?: unknown; sources?: unknown };
      if (typeof r.requestId !== "string" || !Array.isArray(r.sources)) return;
      listener({ requestId: r.requestId, sources: r.sources.filter((s): s is string => typeof s === "string") });
    };
    ipcRenderer.on("agent-check-diagrams", handler);
    return () => {
      ipcRenderer.removeListener("agent-check-diagrams", handler);
    };
  },
  diagramsChecked: (requestId, results) => ipcRenderer.invoke("agent:diagramsChecked", requestId, results),
  onAgentState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AgentState) => listener(state);
    ipcRenderer.on("agent-state", handler);
    return () => {
      ipcRenderer.removeListener("agent-state", handler);
    };
  },
  onAgentShowBoard: (listener) => {
    const handler = (_e: unknown, runId: unknown) => listener(typeof runId === "string" ? runId : undefined);
    ipcRenderer.on("agent-show-board", handler);
    return () => {
      ipcRenderer.removeListener("agent-show-board", handler);
    };
  },
  onAgentOpenCompanion: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("agent-open-companion", handler);
    return () => {
      ipcRenderer.removeListener("agent-open-companion", handler);
    };
  },
  copyText: (text) => ipcRenderer.invoke("app:copyText", text),
  getStaleJiraTask: (prId) => ipcRenderer.invoke("stale:jiraTask", prId),
  closeStalePr: (prId, options) => ipcRenderer.invoke("stale:close", prId, options),
  getWeather: () => ipcRenderer.invoke("weather:get"),
  locateForWeather: () => ipcRenderer.invoke("weather:locate"),
  forgetWeatherLocation: () => ipcRenderer.invoke("weather:forgetLocation"),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DashboardResponse) =>
      listener(payload);
    ipcRenderer.on("snapshot", handler);
    return () => {
      ipcRenderer.removeListener("snapshot", handler);
    };
  },
  onClaudeSessions: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, sessions: ClaudeSessionInfo[]) => listener(sessions);
    ipcRenderer.on("claude-sessions", handler);
    return () => {
      ipcRenderer.removeListener("claude-sessions", handler);
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
  onOpenSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("menu:open-settings", handler);
    return () => {
      ipcRenderer.removeListener("menu:open-settings", handler);
    };
  },
  onRefreshRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("menu:refresh", handler);
    return () => {
      ipcRenderer.removeListener("menu:refresh", handler);
    };
  },
  onFindRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("menu:find", handler);
    return () => {
      ipcRenderer.removeListener("menu:find", handler);
    };
  },
  onNotifySound: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("notify-sound", handler);
    return () => {
      ipcRenderer.removeListener("notify-sound", handler);
    };
  },
};

contextBridge.exposeInMainWorld("api", api);
