import { create } from "zustand";
import type { AppConfig, AppSettings, ShellProfile, SplitDirection, TerminalTab, Workspace } from "../../main/sharedTypes";
import { createId } from "../utils/ids";
import { closePane as closePaneNode, collectPaneIds, createPaneNode, findPane, splitPaneWithId, updateSplitRatio } from "../utils/layout";

interface AppState {
  config: AppConfig | null;
  loaded: boolean;
  sidebarQuery: string;
  settingsOpen: boolean;
  activePaneId: string | null;
  hydrate: () => Promise<void>;
  persist: () => Promise<void>;
  setSidebarQuery: (query: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  addWorkspaceFromFolder: () => Promise<void>;
  removeWorkspace: (workspaceId: string) => void;
  renameWorkspace: (workspaceId: string, name: string) => void;
  selectWorkspace: (workspaceId: string) => void;
  moveWorkspace: (fromIndex: number, toIndex: number) => void;
  addTab: (workspaceId?: string) => void;
  closeTab: (workspaceId: string, tabId: string) => void;
  selectTab: (workspaceId: string, tabId: string) => void;
  renameTab: (workspaceId: string, tabId: string, title: string) => void;
  splitPane: (workspaceId: string, tabId: string, paneId: string, direction: SplitDirection) => void;
  closePane: (workspaceId: string, tabId: string, paneId: string) => void;
  setActivePane: (workspaceId: string, tabId: string, paneId: string) => void;
  setSplitRatio: (workspaceId: string, tabId: string, splitId: string, ratio: number) => void;
  renamePane: (workspaceId: string, tabId: string, paneId: string, title: string) => void;
  setPaneInitialCwd: (workspaceId: string, tabId: string, paneId: string, cwd: string) => void;
  shouldConfirmClosePane: (workspaceId: string, tabId: string) => boolean;
  updateSettings: (settings: Partial<AppSettings>) => void;
  addShellProfile: (profile: Omit<ShellProfile, "id">) => void;
  removeShellProfile: (profileId: string) => void;
}

function shellFor(settings: AppSettings): ShellProfile | null {
  return settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ?? settings.shellProfiles[0] ?? null;
}

function paneMeta(settings: AppSettings, cwd?: string) {
  const shellProfile = shellFor(settings);
  return { cwd, shellProfile, env: { ...(settings.globalEnv ?? {}) }, metadata: { cwd, shellProfileId: shellProfile?.id, shellProfile, env: { ...(settings.globalEnv ?? {}) } } };
}

function newTab(title = "Terminal", cwd?: string, settings?: AppSettings): TerminalTab {
  const pane = createPaneNode(undefined, settings ? paneMeta(settings, cwd) : {});
  return {
    id: createId("tab"),
    title,
    layout: pane,
    activePaneId: pane.id
  };
}

function cloneConfig(config: AppConfig): AppConfig {
  return structuredClone(config);
}

function getActiveWorkspace(config: AppConfig): Workspace | null {
  return config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ?? config.workspaces[0] ?? null;
}

function getActiveWorkspaceId(config: AppConfig): string | null {
  return getActiveWorkspace(config)?.id ?? null;
}

function mutateConfig(set: (partial: Partial<AppState>) => void, get: () => AppState, mutator: (draft: AppConfig) => void): void {
  const { config } = get();
  if (!config) return;

  const draft = cloneConfig(config);
  mutator(draft);
  set({ config: draft });
  void window.tpm.config.save(draft);
}

export const useAppStore = create<AppState>((set, get) => ({
  config: null,
  loaded: false,
  sidebarQuery: "",
  settingsOpen: false,
  activePaneId: null,

  hydrate: async () => {
    const config = await window.tpm.config.load();
    const activeWorkspace = getActiveWorkspace(config);
    const activeTab = activeWorkspace?.tabs.find((tab) => tab.id === activeWorkspace.activeTabId) ?? activeWorkspace?.tabs[0];

    set({
      config: {
        ...config,
        activeWorkspaceId: getActiveWorkspaceId(config)
      },
      activePaneId: activeTab?.activePaneId ?? null,
      loaded: true
    });
  },

  persist: async () => {
    const { config } = get();
    if (config) await window.tpm.config.save(config);
  },

  setSidebarQuery: (query) => set({ sidebarQuery: query }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  addWorkspaceFromFolder: async () => {
    const result = await window.tpm.dialog.selectFolder();
    if (result.canceled || !result.path) return;

    mutateConfig(set, get, (draft) => {
      const terminalTab = newTab("Terminal 1", result.path!, draft.settings);
      const workspace: Workspace = {
        id: createId("workspace"),
        name: result.name ?? result.path!,
        path: result.path!,
        tabs: [terminalTab],
        activeTabId: terminalTab.id,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      draft.workspaces.push(workspace);
      draft.activeWorkspaceId = workspace.id;
    });
  },

  removeWorkspace: (workspaceId) => {
    const workspace = get().config?.workspaces.find((item) => item.id === workspaceId);
    const paneIds = workspace?.tabs.flatMap((tab) => collectPaneIds(tab.layout)) ?? [];
    if (paneIds.length > 0 && !window.confirm("Remove this workspace and kill its terminal sessions?")) return;
    paneIds.forEach((paneId) => window.tpm.pty.kill(paneId));
    mutateConfig(set, get, (draft) => {
      const next = draft.workspaces.filter((workspace) => workspace.id !== workspaceId);
      draft.workspaces = next;
      if (draft.activeWorkspaceId === workspaceId) {
        draft.activeWorkspaceId = next[0]?.id ?? null;
      }
    });
  },

  renameWorkspace: (workspaceId, name) => {
    const normalized = name.trim();
    if (!normalized) return;
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      workspace.name = normalized;
      workspace.updatedAt = Date.now();
    });
  },

  selectWorkspace: (workspaceId) => {
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) return;
      draft.activeWorkspaceId = workspace.id;
      const tab = workspace.tabs.find((item) => item.id === workspace.activeTabId) ?? workspace.tabs[0];
      set({ activePaneId: tab?.activePaneId ?? null });
    });
  },

  moveWorkspace: (fromIndex, toIndex) => {
    mutateConfig(set, get, (draft) => {
      if (fromIndex === toIndex) return;
      if (fromIndex < 0 || toIndex < 0) return;
      if (fromIndex >= draft.workspaces.length || toIndex >= draft.workspaces.length) return;
      const [workspace] = draft.workspaces.splice(fromIndex, 1);
      draft.workspaces.splice(toIndex, 0, workspace);
    });
  },

  addTab: (workspaceId) => {
    mutateConfig(set, get, (draft) => {
      const workspace = workspaceId
        ? draft.workspaces.find((item) => item.id === workspaceId)
        : getActiveWorkspace(draft);
      if (!workspace) return;

      const terminalTab = newTab(`Terminal ${workspace.tabs.length + 1}`, workspace.path, draft.settings);
      workspace.tabs.push(terminalTab);
      workspace.activeTabId = terminalTab.id;
      workspace.updatedAt = Date.now();
      set({ activePaneId: terminalTab.activePaneId });
    });
  },

  closeTab: (workspaceId, tabId) => {
    const existingWorkspace = get().config?.workspaces.find((item) => item.id === workspaceId);
    const existingTab = existingWorkspace?.tabs.find((item) => item.id === tabId);
    const paneIds = existingTab ? collectPaneIds(existingTab.layout) : [];
    if (paneIds.length > 0 && !window.confirm("Close this tab and kill its terminal sessions?")) return;
    paneIds.forEach((paneId) => window.tpm.pty.kill(paneId));
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      if (!workspace || workspace.tabs.length <= 1) return;
      const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return;
      workspace.tabs.splice(index, 1);
      if (workspace.activeTabId === tabId) {
        workspace.activeTabId = workspace.tabs[Math.max(0, index - 1)]?.id ?? workspace.tabs[0].id;
      }
      const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? workspace.tabs[0];
      set({ activePaneId: activeTab.activePaneId });
      workspace.updatedAt = Date.now();
    });
  },

  selectTab: (workspaceId, tabId) => {
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      if (!workspace || !tab) return;
      workspace.activeTabId = tab.id;
      set({ activePaneId: tab.activePaneId });
    });
  },

  renameTab: (workspaceId, tabId, title) => {
    const normalized = title.trim();
    if (!normalized) return;
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      tab.title = normalized;
      workspace!.updatedAt = Date.now();
    });
  },

  splitPane: (workspaceId, tabId, paneId, direction) => {
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      const newPaneId = createId("pane");
      tab.layout = splitPaneWithId(tab.layout, paneId, direction, newPaneId);
      tab.activePaneId = newPaneId;
      workspace!.updatedAt = Date.now();
      set({ activePaneId: newPaneId });
    });
  },

  closePane: (workspaceId, tabId, paneId) => {
    window.tpm.pty.kill(paneId);
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      const paneCount = collectPaneIds(tab.layout).length;
      if (paneCount <= 1) return;
      tab.layout = closePaneNode(tab.layout, paneId);
      const paneIds = collectPaneIds(tab.layout);
      tab.activePaneId = paneIds.includes(tab.activePaneId) ? tab.activePaneId : paneIds[0];
      workspace!.updatedAt = Date.now();
      set({ activePaneId: tab.activePaneId });
    });
  },

  setActivePane: (workspaceId, tabId, paneId) => {
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      tab.activePaneId = paneId;
      set({ activePaneId: paneId });
    });
  },

  setSplitRatio: (workspaceId, tabId, splitId, ratio) => {
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      if (!tab) return;
      tab.layout = updateSplitRatio(tab.layout, splitId, ratio);
      workspace!.updatedAt = Date.now();
    });
  },

  renamePane: (workspaceId, tabId, paneId, title) => {
    const normalized = title.trim();
    if (!normalized) return;
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      const pane = tab ? findPane(tab.layout, paneId) : null;
      if (!pane) return;
      pane.title = normalized;
      pane.metadata = { ...((pane.metadata ?? {}) as Record<string, unknown>), title: normalized };
      pane.promptLabel = normalized;
      workspace!.updatedAt = Date.now();
    });
  },

  setPaneInitialCwd: (workspaceId, tabId, paneId, cwd) => {
    const normalized = cwd.trim();
    if (!normalized) return;
    mutateConfig(set, get, (draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      const tab = workspace?.tabs.find((item) => item.id === tabId);
      const pane = tab ? findPane(tab.layout, paneId) : null;
      if (!pane) return;
      pane.cwd = normalized;
      pane.metadata = { ...((pane.metadata ?? {}) as Record<string, unknown>), cwd: normalized };
      workspace!.updatedAt = Date.now();
    });
  },

  shouldConfirmClosePane: (workspaceId, tabId) => {
    const { config } = get();
    const workspace = config?.workspaces.find((item) => item.id === workspaceId);
    const tab = workspace?.tabs.find((item) => item.id === tabId);
    if (!config || !tab || !config.settings.confirmBeforeClosingPane) return false;
    return collectPaneIds(tab.layout).length > 1;
  },

  updateSettings: (settings) => {
    mutateConfig(set, get, (draft) => {
      draft.settings = { ...draft.settings, ...settings };
    });
  },

  addShellProfile: (profile) => {
    mutateConfig(set, get, (draft) => {
      draft.settings.shellProfiles.push({ ...profile, id: createId("shell") });
    });
  },

  removeShellProfile: (profileId) => {
    mutateConfig(set, get, (draft) => {
      if (draft.settings.shellProfiles.length <= 1) return;
      draft.settings.shellProfiles = draft.settings.shellProfiles.filter((profile) => profile.id !== profileId);
      if (draft.settings.defaultShellProfileId === profileId) {
        draft.settings.defaultShellProfileId = draft.settings.shellProfiles[0]!.id;
      }
    });
  }
}));
