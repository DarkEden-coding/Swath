import { ipcMain } from "electron";
import {
  IpcChannels,
  ptyResizeRequestSchema,
  terminalSessionAttachRequestSchema,
  terminalSessionStartRequestSchema,
} from "../../shared/ipc";
import type { PtyResizeRequest, TerminalSessionAttachRequest, TerminalSessionStartRequest } from "../../shared/types";
import type { TerminalSessionManager } from "../ptyManager";

interface RegisterTerminalIpcOptions {
  getTerminalManager: () => TerminalSessionManager | null;
}

export function registerTerminalIpc({ getTerminalManager }: RegisterTerminalIpcOptions): void {
  const create = (_event: unknown, request: TerminalSessionStartRequest) =>
    getTerminalManager()?.create(terminalSessionStartRequestSchema.parse(request) as TerminalSessionStartRequest);
  const write = (_event: unknown, sessionId: string, data: string) => getTerminalManager()?.write(sessionId, data);
  const resize = (_event: unknown, request: PtyResizeRequest) =>
    getTerminalManager()?.resize(ptyResizeRequestSchema.parse(request));
  const kill = (_event: unknown, sessionId: string) => getTerminalManager()?.kill(sessionId);

  ipcMain.on(IpcChannels.terminalCreate, create);
  ipcMain.on(IpcChannels.terminalWrite, write);
  ipcMain.on(IpcChannels.terminalResize, resize);
  ipcMain.on(IpcChannels.terminalKill, kill);
  ipcMain.handle(IpcChannels.terminalAttach, (_event, request: TerminalSessionAttachRequest) =>
    getTerminalManager()?.attach(terminalSessionAttachRequestSchema.parse(request) as TerminalSessionAttachRequest),
  );
  ipcMain.handle(IpcChannels.terminalRestart, (_event, sessionId: string) => getTerminalManager()?.restart(sessionId));
  ipcMain.handle(IpcChannels.terminalReplay, (_event, sessionId: string) => getTerminalManager()?.replay(sessionId));
  ipcMain.handle(IpcChannels.terminalIsBusy, (_event, sessionId: string) => getTerminalManager()?.isBusy(sessionId) ?? false);
}
