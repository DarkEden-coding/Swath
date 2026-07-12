/// <reference types="vite/client" />
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IpcChannels } from "../shared/ipc/channels";
import type { AppConfig } from "../shared/types";
import type { GitRpcRequest } from "../shared/ipc/gitRpc";

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
      confirm: async (request) => window.confirm(request.detail ? `${request.message}\n\n${request.detail}` : request.message),
    },
    clipboard: {
      readForTerminal: async () => ({ text: "", hasImage: false }),
      writeText: async () => {},
    },
    browser: {
      openExternal: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    permissions: {
      ensureTerminalPaste: async () => ({ accessibility: "unavailable" }),
    },
    terminal: {
      create: async () => {},
      write: async () => {},
      resize: () => {},
      kill: () => {},
      attach: async () => ({ sessionId: "", running: false }),
      restart: async () => ({ sessionId: "", running: false }),
      replay: async () => ({ sessionId: "", running: false }),
      setStreaming: () => {},
      isBusy: async () => false,
      onData: () => () => {},
      onExit: () => () => {},
    },
    app: {
      onCommand: () => () => {},
    },
    git: {
      rpc: async (request: GitRpcRequest) => {
        if (request.op === "getStatus") {
          return {
            ok: true,
            branch: "main",
            staged: [
              { path: "src/utils/format.ts", status: "M" },
              { path: "package.json", status: "A" },
            ],
            unstaged: [
              { path: "src/App.tsx", status: "M" },
              { path: "src/styles.css", status: "M" },
            ],
            untracked: [],
            stderr: "",
          };
        }
        if (request.op === "getLog") {
          return {
            ok: true,
            commits: [
              {
                graph: "* ",
                hash: `${"a".repeat(39)}1`,
                parents: [`${"c".repeat(39)}3`],
                short: "a1b2c3d",
                subject: "Add user settings page",
                author: "Alex Kim",
                date: "2 hours ago",
                refs: "HEAD -> main, origin/main",
              },
              {
                graph: "| * ",
                hash: `${"b".repeat(39)}2`,
                parents: [`${"c".repeat(39)}3`],
                short: "b2c3d4e",
                subject: "Implement auth flow",
                author: "Alex Kim",
                date: "1 day ago",
                refs: "feature/auth",
              },
              {
                graph: "|/  ",
                hash: `${"c".repeat(39)}3`,
                parents: [`${"b".repeat(39)}2`, `${"d".repeat(39)}4`],
                short: "c3d4e5f",
                subject: "Merge branch feature/auth",
                author: "Alex Kim",
                date: "3 days ago",
                refs: "",
              },
            ],
          };
        }
        if (request.op === "listBranches") {
          return { ok: true, branches: ["feature/auth", "main", "origin/main"] };
        }
        if (request.op === "checkoutBranch") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (request.op === "stagePaths" || request.op === "unstagePaths" || request.op === "discardPaths") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (request.op === "commit" || request.op === "pull" || request.op === "push" || request.op === "sync") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "Unavailable" };
      },
    },
  };
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createTauriSwath(): SwathApi {
  return {
    platform: typeof navigator !== "undefined" ? (navigator.platform.includes("Win") ? "win32" : "darwin") : "darwin",
    config: {
      load: () => invoke("config_load"),
      save: (config: AppConfig) => invoke("config_save", { config }),
    },
    dialog: {
      selectFolder: () => invoke("dialog_select_folder"),
      confirm: (request) => invoke("dialog_confirm", { request }),
    },
    clipboard: {
      readForTerminal: () => invoke("clipboard_read_for_terminal"),
      writeText: (text: string) => invoke("clipboard_write_text", { text }),
    },
    browser: {
      openExternal: (url: string) => invoke("browser_open_external", { url }),
    },
    permissions: {
      ensureTerminalPaste: () => invoke("permissions_ensure_terminal_paste"),
    },
    terminal: {
      create: (request) => invoke("terminal_create", { request }),
      write: (sessionId, data) => invoke("terminal_write", { sessionId, data }),
      resize: (request) => { void invoke("terminal_resize", { request }); },
      kill: (sessionId) => { void invoke("terminal_kill", { sessionId }); },
      attach: (request) => invoke("terminal_attach", { request }),
      restart: (sessionId) => invoke("terminal_restart", { sessionId }),
      replay: (sessionId) => invoke("terminal_replay", { sessionId }),
      setStreaming: (sessionId, enabled) => {
        void invoke("terminal_set_streaming", { sessionId, enabled });
      },
      isBusy: (sessionId) => invoke("terminal_is_busy", { sessionId }),
      onData: (callback) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void listen<{ sessionId: string; data: string }>(IpcChannels.terminalData, (event) => {
          callback(event.payload.sessionId, event.payload.data);
        }).then((unlisten) => {
          unsubscribe = unlisten;
          if (disposed) unlisten();
        });
        return () => {
          disposed = true;
          unsubscribe?.();
        };
      },
      onExit: (callback) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void listen<{ sessionId: string; exitCode: number; signal?: number }>(IpcChannels.terminalExit, (event) => {
          callback(event.payload.sessionId, { exitCode: event.payload.exitCode, signal: event.payload.signal });
        }).then((unlisten) => {
          unsubscribe = unlisten;
          if (disposed) unlisten();
        });
        return () => {
          disposed = true;
          unsubscribe?.();
        };
      },
    },
    app: {
      onCommand: (callback) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void listen<string>(IpcChannels.appCommand, (event) => callback(event.payload)).then((unlisten) => {
          unsubscribe = unlisten;
          if (disposed) unlisten();
        });
        return () => {
          disposed = true;
          unsubscribe?.();
        };
      },
    },
    git: {
      rpc: (request: GitRpcRequest) => invoke("git_rpc", { request }),
    },
  };
}

export function attachSwathAdapterIfMissing(): void {
  if (typeof window === "undefined") return;
  if ("swath" in window && window.swath) return;

  if (isTauriRuntime()) {
    (window as unknown as { swath: SwathApi }).swath = createTauriSwath();
    return;
  }

  if (import.meta.env.DEV) {
    (window as unknown as { swath: SwathApi }).swath = createStubSwath();
  }
}

export const attachViteBrowserTpmIfMissing = attachSwathAdapterIfMissing;
