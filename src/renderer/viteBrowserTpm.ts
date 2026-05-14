/// <reference types="vite/client" />
import type { AppConfig } from "../shared/types";
import type { SwathApi } from "../main/preload";

const browserDevConfig: AppConfig = {
  version: 2,
  activeWorkspaceId: "browser-ws-1",
  workspaces: [
    {
      id: "browser-ws-1",
      name: "Acme Platform",
      path: "/",
      createdAt: 0,
      updatedAt: 0,
      activeViewId: "browser-tab-1",
      views: [
        {
          id: "browser-tab-1",
          title: "Backend API Dev",
          health: "healthy",
          activePaneId: "browser-pane-1",
          layout: {
            type: "pane",
            kind: "terminal",
            id: "browser-pane-1",
            promptLabel: "api@acme-platform: ~/projects/api",
          },
        },
        {
          id: "browser-tab-2",
          title: "Database Console",
          health: "warning",
          activePaneId: "browser-pane-2",
          layout: { type: "pane", kind: "terminal", id: "browser-pane-2", promptLabel: "postgres@acme-platform: ~" },
        },
      ],
    },
    {
      id: "browser-ws-2",
      name: "API Gateway",
      path: "/",
      createdAt: 0,
      updatedAt: 0,
      activeViewId: "browser-tab-3",
      views: [
        {
          id: "browser-tab-3",
          title: "Terminal",
          health: "idle",
          activePaneId: "browser-pane-3",
          layout: { type: "pane", kind: "terminal", id: "browser-pane-3" },
        },
      ],
    },
  ],
  settings: {
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: "block",
    defaultShellProfileId: "zsh",
    shellProfiles: [
      { id: "zsh", name: "zsh", command: "/bin/zsh", args: ["-l"] },
      { id: "bash", name: "bash", command: "/bin/bash", args: ["-l"] },
    ],
    globalEnv: {},
    confirmBeforeClosingPane: false,
  },
};

function createStubSwath(): SwathApi {
  let saved: AppConfig = structuredClone(browserDevConfig);

  return {
    platform: typeof navigator !== "undefined" ? (navigator.platform.includes("Win") ? "win32" : "darwin") : "darwin",
    config: {
      load: async () => structuredClone(saved),
      save: async (config: AppConfig) => {
        saved = structuredClone(config);
      },
    },
    dialog: {
      selectFolder: async () => ({ canceled: true, path: null, name: null }),
    },
    clipboard: {
      readForTerminal: async () => ({ text: "", imagePath: null }),
    },
    permissions: {
      ensureTerminalPaste: async () => ({ accessibility: "unavailable" }),
    },
    terminal: {
      create: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
      attach: async () => ({ sessionId: "", running: false }),
      restart: async () => ({ sessionId: "", running: false }),
      replay: async () => ({ sessionId: "", running: false }),
      isBusy: async () => false,
      onData: () => () => {},
      onExit: () => () => {},
    },
    app: {
      onCommand: () => () => {},
    },
  };
}

export function attachViteBrowserTpmIfMissing(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.DEV) return;
  if ("swath" in window && window.swath) return;

  (window as unknown as { swath: SwathApi }).swath = createStubSwath();
}
