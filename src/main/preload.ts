import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IpcChannels, type GitRpcRequest } from "../shared/ipc";
import type {
  AppConfig,
  ConfirmDialogRequest,
  FolderSelectResult,
  PtyResizeRequest,
  TerminalClipboardPayload,
  TerminalPastePermissionStatus,
  TerminalSessionAttachRequest,
  TerminalSessionStartRequest,
  TerminalSessionStatus,
} from "../shared/types";

const swath = {
  platform: process.platform,
  config: {
    load: (): Promise<AppConfig> => ipcRenderer.invoke(IpcChannels.configLoad),
    save: (config: AppConfig): Promise<void> => ipcRenderer.invoke(IpcChannels.configSave, config),
  },
  dialog: {
    selectFolder: (): Promise<FolderSelectResult> => ipcRenderer.invoke(IpcChannels.dialogSelectFolder),
    confirm: (request: ConfirmDialogRequest): Promise<boolean> => ipcRenderer.invoke(IpcChannels.dialogConfirm, request),
  },
  clipboard: {
    readForTerminal: (): Promise<TerminalClipboardPayload> => ipcRenderer.invoke(IpcChannels.clipboardReadForTerminal),
    writeText: (text: string): Promise<void> => ipcRenderer.invoke(IpcChannels.clipboardWriteText, text),
  },
  permissions: {
    ensureTerminalPaste: (): Promise<TerminalPastePermissionStatus> =>
      ipcRenderer.invoke(IpcChannels.permissionsEnsureTerminalPaste),
  },
  terminal: {
    create: (request: TerminalSessionStartRequest): void => ipcRenderer.send(IpcChannels.terminalCreate, request),
    write: (sessionId: string, data: string): void => ipcRenderer.send(IpcChannels.terminalWrite, sessionId, data),
    resize: (request: PtyResizeRequest): void => ipcRenderer.send(IpcChannels.terminalResize, request),
    kill: (sessionId: string): void => ipcRenderer.send(IpcChannels.terminalKill, sessionId),
    attach: (request: TerminalSessionAttachRequest): Promise<TerminalSessionStatus | undefined> =>
      ipcRenderer.invoke(IpcChannels.terminalAttach, request),
    restart: (sessionId: string): Promise<TerminalSessionStatus | undefined> =>
      ipcRenderer.invoke(IpcChannels.terminalRestart, sessionId),
    replay: (sessionId: string): Promise<TerminalSessionStatus | undefined> =>
      ipcRenderer.invoke(IpcChannels.terminalReplay, sessionId),
    isBusy: (sessionId: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.terminalIsBusy, sessionId),
    onData: (callback: (sessionId: string, data: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, data: string): void => {
        callback(sessionId, data);
      };
      ipcRenderer.on(IpcChannels.terminalData, listener);
      return () => ipcRenderer.removeListener(IpcChannels.terminalData, listener);
    },
    onExit: (
      callback: (sessionId: string, event: { exitCode: number; signal?: number }) => void,
    ): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, event: { exitCode: number; signal?: number }): void => {
        callback(sessionId, event);
      };
      ipcRenderer.on(IpcChannels.terminalExit, listener);
      return () => ipcRenderer.removeListener(IpcChannels.terminalExit, listener);
    },
  },
  git: {
    rpc: (request: GitRpcRequest): Promise<unknown> => ipcRenderer.invoke(IpcChannels.gitRpc, request),
  },
  app: {
    onCommand: (callback: (command: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, command: string): void => callback(command);
      ipcRenderer.on(IpcChannels.appCommand, listener);
      return () => ipcRenderer.removeListener(IpcChannels.appCommand, listener);
    },
  },
} as const;

contextBridge.exposeInMainWorld("swath", swath);

export type SwathApi = typeof swath;
