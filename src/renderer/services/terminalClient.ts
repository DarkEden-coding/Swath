import type {
  PtyResizeRequest,
  TerminalSessionAttachRequest,
  TerminalSessionStartRequest,
  TerminalSessionStatus,
} from "../../shared/types";
import { subscribeTerminalData, subscribeTerminalExit } from "./terminalEventHub";

export const terminalClient = {
  create: (request: TerminalSessionStartRequest): Promise<void> => window.swath.terminal.create(request),
  write: (sessionId: string, data: string): Promise<void> => window.swath.terminal.write(sessionId, data),
  resize: (request: PtyResizeRequest): void => window.swath.terminal.resize(request),
  kill: (sessionId: string): void => window.swath.terminal.kill(sessionId),
  attach: (request: TerminalSessionAttachRequest): Promise<TerminalSessionStatus | undefined> => window.swath.terminal.attach(request),
  restart: (sessionId: string): Promise<TerminalSessionStatus | undefined> => window.swath.terminal.restart(sessionId),
  replay: (sessionId: string): Promise<TerminalSessionStatus | undefined> => window.swath.terminal.replay(sessionId),
  setStreaming: (sessionId: string, enabled: boolean): void => window.swath.terminal.setStreaming(sessionId, enabled),
  isBusy: (sessionId: string): Promise<boolean> => window.swath.terminal.isBusy(sessionId),
  onData: subscribeTerminalData,
  onExit: subscribeTerminalExit,
};
