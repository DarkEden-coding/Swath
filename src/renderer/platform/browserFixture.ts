import type { SwathApi } from "../../shared/ipc/swath";
import type { GitRpcRequest } from "../../shared/ipc/gitRpc";
import type { AppConfig } from "../../shared/types";

/** Demo configuration used only by Vite's browser development mode. */
export const browserDevConfig: AppConfig = {
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
          layout: {
            type: "pane",
            kind: "terminal",
            id: "browser-pane-2",
            promptLabel: "postgres@acme-platform: ~",
          },
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

export function createBrowserStubSwath(): SwathApi {
  let saved: AppConfig = structuredClone(browserDevConfig);

  return {
    platform:
      typeof navigator !== "undefined"
        ? navigator.platform.includes("Win")
          ? "win32"
          : "darwin"
        : "darwin",
    config: {
      load: async () => structuredClone(saved),
      save: async (config: AppConfig) => {
        saved = structuredClone(config);
      },
    },
    dialog: {
      selectFolder: async () => ({ canceled: true, path: null, name: null }),
      confirm: async (request) =>
        window.confirm(
          request.detail ? `${request.message}\n\n${request.detail}` : request.message,
        ),
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
        if (
          request.op === "stagePaths" ||
          request.op === "unstagePaths" ||
          request.op === "discardPaths"
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (
          request.op === "commit" ||
          request.op === "pull" ||
          request.op === "push" ||
          request.op === "sync"
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "Unavailable" };
      },
      onData: () => () => {},
    },
  };
}
