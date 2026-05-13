/// <reference types="vite/client" />
import type { AppConfig } from "../main/sharedTypes";
import type { TpmApi } from "../main/preload";

const browserDevConfig: AppConfig = {
  version: 1,
  activeWorkspaceId: "browser-ws-1",
  workspaces: [
    {
      id: "browser-ws-1",
      name: "Acme Platform",
      path: "/",
      createdAt: 0,
      updatedAt: 0,
      activeTabId: "browser-tab-1",
      tabs: [
        {
          id: "browser-tab-1",
          title: "Backend API Dev",
          health: "healthy",
          activePaneId: "browser-pane-1",
          layout: {
            type: "pane",
            id: "browser-pane-1",
            promptLabel: "api@acme-platform: ~/projects/api"
          }
        },
        {
          id: "browser-tab-2",
          title: "Database Console",
          health: "warning",
          activePaneId: "browser-pane-2",
          layout: { type: "pane", id: "browser-pane-2", promptLabel: "postgres@acme-platform: ~" }
        }
      ]
    },
    {
      id: "browser-ws-2",
      name: "API Gateway",
      path: "/",
      createdAt: 0,
      updatedAt: 0,
      activeTabId: "browser-tab-3",
      tabs: [
        {
          id: "browser-tab-3",
          title: "Terminal",
          health: "idle",
          activePaneId: "browser-pane-3",
          layout: { type: "pane", id: "browser-pane-3" }
        }
      ]
    }
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
      { id: "bash", name: "bash", command: "/bin/bash", args: ["-l"] }
    ],
    globalEnv: {},
    confirmBeforeClosingPane: false
  }
};

function createStubTpm(): TpmApi {
  let saved: AppConfig = structuredClone(browserDevConfig);

  return {
    platform: typeof navigator !== "undefined" ? (navigator.platform.includes("Win") ? "win32" : "darwin") : "darwin",
    config: {
      load: async () => structuredClone(saved),
      save: async (config: AppConfig) => {
        saved = structuredClone(config);
      }
    },
    dialog: {
      selectFolder: async () => ({ canceled: true, path: null, name: null })
    },
    clipboard: {
      readForTerminal: async () => ({ text: "", imagePath: null })
    },
    permissions: {
      ensureTerminalPaste: async () => ({ accessibility: "unavailable" })
    },
    pty: {
      create: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => () => {},
      onExit: () => () => {}
    },
    app: {
      onCommand: () => () => {}
    }
  };
}

export function attachViteBrowserTpmIfMissing(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.DEV) return;
  if ("tpm" in window && window.tpm) return;

  (window as unknown as { tpm: TpmApi }).tpm = createStubTpm();
}
