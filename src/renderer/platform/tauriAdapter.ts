import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IpcChannels } from "../../shared/ipc/channels";
import { TauriCommands } from "../../shared/ipc/swath";
import type { SwathApi } from "../../shared/ipc/swath";
import type { AppConfig } from "../../shared/types";
import type { FilesRpcRequest } from "../../shared/ipc/filesRpc";
import type { GitRpcRequest } from "../../shared/ipc/gitRpc";
import type { AskImagesRequest } from "../../shared/ipc/askImages";
import type { PiHostEvent, PiRpcRequest } from "../../shared/ipc/piRpc";
import type { TaskRpcRequest } from "../../shared/ipc/taskRpc";
import { detectHostPlatform } from "./runtime";

/** Creates the renderer API backed by Tauri commands and events. */
export function createTauriSwath(): SwathApi {
  return {
    platform: detectHostPlatform(),
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
    askImages: {
      load: (request: AskImagesRequest) => invoke(TauriCommands.askImagesLoad, { request }),
    },
    files: {
      rpc: (request: FilesRpcRequest) => invoke(TauriCommands.filesRpc, { request }),
    },
    tasks: { rpc: (request: TaskRpcRequest) => invoke(TauriCommands.taskRpc, { request }) },
    pi: {
      rpc: (request: PiRpcRequest) => invoke(TauriCommands.piRpc, { request }),
      onEvent: (callback) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void listen<PiHostEvent>(IpcChannels.piEvent, (event) => {
          const { paneId, line, exit } = event.payload;
          callback(paneId, line, exit === true);
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
    sync: {
      snapshot: (networkId) => invoke(TauriCommands.syncSnapshot, { networkId }),
      changes: (networkId, cursor) => invoke(TauriCommands.syncChanges, { networkId, cursor }),
      ack: (networkId, cursor) => invoke(TauriCommands.syncAck, { networkId, cursor }),
      conflicts: (networkId) => invoke(TauriCommands.syncConflicts, { networkId }),
    },
    network: {
      current: () => invoke(TauriCommands.networkCurrent),
      initialize: (name) => invoke(TauriCommands.networkInitialize, { name }),
      discover: () => invoke(TauriCommands.networkDiscover),
      requestJoin: (networkId, endpoint, enrollmentSecret) =>
        invoke(TauriCommands.networkRequestJoin, { networkId, endpoint, enrollmentSecret }),
      joinStatus: (enrollmentId) => invoke(TauriCommands.networkJoinStatus, { enrollmentId }),
      approveJoin: (networkId, enrollmentId) =>
        invoke(TauriCommands.networkApproveJoin, { networkId, enrollmentId }),
      membership: (networkId) => invoke(TauriCommands.networkMembership, { networkId }),
      promote: (networkId, deviceId) =>
        invoke(TauriCommands.networkPromote, { networkId, deviceId }),
      demote: (networkId, deviceId) => invoke(TauriCommands.networkDemote, { networkId, deviceId }),
      health: (networkId) => invoke(TauriCommands.networkHealth, { networkId }),
    },
    catalog: {
      snapshot: (networkId) => invoke(TauriCommands.catalogSnapshot, { networkId }),
      mutate: (request) => invoke(TauriCommands.catalogMutate, { request }),
    },
    migration: {
      status: () => invoke(TauriCommands.migrationStatus),
      preview: (operationId) => invoke(TauriCommands.migrationPreview, { operationId }),
      confirm: (request) => invoke(TauriCommands.migrationConfirm, { request }),
      export: () => invoke(TauriCommands.migrationExport),
      conflicts: () => invoke(TauriCommands.migrationConflicts),
      submitProposal: (proposal) => invoke(TauriCommands.migrationSubmitProposal, { proposal }),
      approveProposal: (approval) => invoke(TauriCommands.migrationApproveProposal, { approval }),
    },
    localState: {
      load: async (networkId) => {
        const saved = (await invoke(TauriCommands.localStateLoad, {
          interfaceId: `task:${networkId}`,
        })) as { revision: number } | null;
        return saved
          ? {
              revision: saved.revision,
              state: {
                ...saved,
                historicalTaskId: (saved as any).historicalTaskId ?? null,
                paneOrderByTask: (saved as any).taskLayouts ?? {},
              },
            }
          : null;
      },
      save: async (networkId, state, revision) => {
        const local = state as Record<string, unknown>;
        await invoke(TauriCommands.localStateSave, {
          expectedRevision: revision - 1,
          localState: {
            interfaceId: `task:${networkId}`,
            activeProjectId: local.activeProjectId ?? null,
            activeTaskId: local.activeTaskId ?? null,
            historicalTaskId: local.historicalTaskId ?? null,
            focusedPaneId: local.focusedPaneId ?? null,
            taskLayouts: local.paneOrderByTask ?? {},
            drafts: local.drafts ?? {},
            revision,
          },
        });
        return revision;
      },
    },
    remote: {
      connect: async () => {
        throw new Error("Remote transport is not initialized");
      },
      forget: () => {},
      status: () => "offline",
      onStatus: () => () => {},
      listFolders: async () => {
        throw new Error("Remote transport is not initialized");
      },
      serverStart: (options) => invoke(TauriCommands.remoteServerStart, { options }),
      serverStop: () => invoke(TauriCommands.remoteServerStop),
      serverStatus: () => invoke(TauriCommands.remoteServerStatus),
    },
  };
}
