import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppConfig,
  FolderSelectResult,
  PtyCreateRequest,
  PtyResizeRequest,
  TerminalSessionAttachRequest,
  TerminalSessionStatus,
} from "./sharedTypes";

const api = {
  platform: process.platform,
  config: {
    load: (): Promise<AppConfig> => ipcRenderer.invoke("config:load"),
    save: (config: AppConfig): Promise<void> => ipcRenderer.invoke("config:save", config)
  },
  dialog: {
    selectFolder: (): Promise<FolderSelectResult> => ipcRenderer.invoke("dialog:select-folder")
  },
  pty: {
    create: (request: PtyCreateRequest): void => ipcRenderer.send("pty:create", request),
    write: (sessionId: string, data: string): void => ipcRenderer.send("pty:write", sessionId, data),
    resize: (request: PtyResizeRequest): void => ipcRenderer.send("pty:resize", request),
    kill: (sessionId: string): void => ipcRenderer.send("pty:kill", sessionId),
    onData: (callback: (sessionId: string, data: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, data: string): void => {
        callback(sessionId, data);
      };
      ipcRenderer.on("pty:data", listener);
      return () => ipcRenderer.removeListener("pty:data", listener);
    },
    onExit: (
      callback: (sessionId: string, event: { exitCode: number; signal?: number }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        sessionId: string,
        event: { exitCode: number; signal?: number }
      ): void => {
        callback(sessionId, event);
      };
      ipcRenderer.on("pty:exit", listener);
      return () => ipcRenderer.removeListener("pty:exit", listener);
    }
  },
  terminalSession: {
    attach: (request: TerminalSessionAttachRequest): Promise<TerminalSessionStatus | undefined> =>
      ipcRenderer.invoke("terminal-session:attach", request),
    restart: (sessionId: string): Promise<TerminalSessionStatus | undefined> =>
      ipcRenderer.invoke("terminal-session:restart", sessionId),
    replay: (sessionId: string): Promise<TerminalSessionStatus | undefined> =>
      ipcRenderer.invoke("terminal-session:replay", sessionId),
    isRunning: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke("terminal-session:is-running", sessionId),
    write: (sessionId: string, data: string): void =>
      ipcRenderer.send("terminal-session:write", sessionId, data),
    resize: (request: PtyResizeRequest): void =>
      ipcRenderer.send("terminal-session:resize", request),
    kill: (sessionId: string): void => ipcRenderer.send("terminal-session:kill", sessionId),
    onData: (callback: (sessionId: string, data: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, sessionId: string, data: string): void => {
        callback(sessionId, data);
      };
      ipcRenderer.on("terminal-session:data", listener);
      return () => ipcRenderer.removeListener("terminal-session:data", listener);
    },
    onExit: (
      callback: (sessionId: string, event: { exitCode: number; signal?: number }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        sessionId: string,
        event: { exitCode: number; signal?: number }
      ): void => callback(sessionId, event);
      ipcRenderer.on("terminal-session:exit", listener);
      return () => ipcRenderer.removeListener("terminal-session:exit", listener);
    }
  },
  app: {
    onCommand: (callback: (command: string) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, command: string): void => callback(command);
      ipcRenderer.on("app:command", listener);
      return () => ipcRenderer.removeListener("app:command", listener);
    }
  }
};

contextBridge.exposeInMainWorld("tpm", api);

export type TpmApi = Omit<typeof api, "terminalSession"> & {
  terminalSession?: typeof api.terminalSession;
};
