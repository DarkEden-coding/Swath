import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IpcChannels } from "../../shared/ipc/channels";
import { TauriCommands } from "../../shared/ipc/swath";
import type { SwathApi } from "../../shared/ipc/swath";
import type { AppConfig } from "../../shared/types";
import type { GitRpcRequest } from "../../shared/ipc/gitRpc";
import type { ImageRpcRequest } from "../../shared/ipc/imageRpc";

/** Creates the renderer API backed by Tauri commands and events. */
export function createTauriSwath(): SwathApi {
  return {
    platform:
      typeof navigator !== "undefined"
        ? navigator.platform.includes("Win")
          ? "win32"
          : "darwin"
        : "darwin",
    config: {
      load: () => invoke(TauriCommands.configLoad),
      save: (config: AppConfig) => invoke(TauriCommands.configSave, { config }),
    },
    dialog: {
      selectFolder: () => invoke(TauriCommands.dialogSelectFolder),
      confirm: (request) => invoke(TauriCommands.dialogConfirm, { request }),
    },
    clipboard: {
      readForTerminal: () => invoke(TauriCommands.clipboardReadForTerminal),
      writeText: (text: string) => invoke(TauriCommands.clipboardWriteText, { text }),
    },
    browser: {
      openExternal: (url: string) => invoke(TauriCommands.browserOpenExternal, { url }),
    },
    permissions: {
      ensureTerminalPaste: () => invoke(TauriCommands.permissionsEnsureTerminalPaste),
    },
    terminal: {
      create: (request) => invoke(TauriCommands.terminalCreate, { request }),
      write: (sessionId, data) => invoke(TauriCommands.terminalWrite, { sessionId, data }),
      resize: (request) => {
        void invoke(TauriCommands.terminalResize, { request });
      },
      kill: (sessionId) => {
        void invoke(TauriCommands.terminalKill, { sessionId });
      },
      attach: (request) => invoke(TauriCommands.terminalAttach, { request }),
      restart: (sessionId) => invoke(TauriCommands.terminalRestart, { sessionId }),
      replay: (sessionId) => invoke(TauriCommands.terminalReplay, { sessionId }),
      setStreaming: (sessionId, enabled) => {
        void invoke(TauriCommands.terminalSetStreaming, { sessionId, enabled });
      },
      isBusy: (sessionId) => invoke(TauriCommands.terminalIsBusy, { sessionId }),
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
        void listen<{ sessionId: string; exitCode: number; signal?: number }>(
          IpcChannels.terminalExit,
          (event) => {
            callback(event.payload.sessionId, {
              exitCode: event.payload.exitCode,
              signal: event.payload.signal,
            });
          },
        ).then((unlisten) => {
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
        void listen<string>(IpcChannels.appCommand, (event) => callback(event.payload)).then(
          (unlisten) => {
            unsubscribe = unlisten;
            if (disposed) unlisten();
          },
        );
        return () => {
          disposed = true;
          unsubscribe?.();
        };
      },
    },
    git: {
      rpc: (request: GitRpcRequest) => invoke(TauriCommands.gitRpc, { request }),
      onData: (callback) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void listen<{ runId: string; data: string }>(IpcChannels.gitData, (event) => {
          callback(event.payload.runId, event.payload.data);
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
    image: {
      rpc: (request: ImageRpcRequest) => invoke(TauriCommands.imageRpc, { request }),
    },
  };
}
