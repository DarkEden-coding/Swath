import type {
  PtyResizeRequest,
  TerminalSessionAttachRequest,
  TerminalSessionStartRequest,
  TerminalSessionStatus,
} from "../../shared/types";

export const terminalClient = {
  create: (request: TerminalSessionStartRequest): void => window.swath.terminal.create(request),
  write: (sessionId: string, data: string): void => window.swath.terminal.write(sessionId, data),
  resize: (request: PtyResizeRequest): void => window.swath.terminal.resize(request),
  kill: (sessionId: string): void => window.swath.terminal.kill(sessionId),
  attach: (request: TerminalSessionAttachRequest): Promise<TerminalSessionStatus | undefined> => window.swath.terminal.attach(request),
  restart: (sessionId: string): Promise<TerminalSessionStatus | undefined> => window.swath.terminal.restart(sessionId),
  replay: (sessionId: string): Promise<TerminalSessionStatus | undefined> => window.swath.terminal.replay(sessionId),
  isBusy: (sessionId: string): Promise<boolean> => window.swath.terminal.isBusy(sessionId),
  onData: (callback: (sessionId: string, data: string) => void): (() => void) => window.swath.terminal.onData(callback),
  onExit: (callback: (sessionId: string, event: { exitCode: number; signal?: number }) => void): (() => void) =>
    window.swath.terminal.onExit(callback),
};
