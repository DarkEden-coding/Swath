type TerminalDataHandler = (sessionId: string, data: string) => void;
type TerminalExitHandler = (
  sessionId: string,
  event: { exitCode: number; signal?: number },
) => void;

const dataHandlers = new Map<number, TerminalDataHandler>();
const exitHandlers = new Map<number, TerminalExitHandler>();
let dataListener: (() => void) | undefined;
let exitListener: (() => void) | undefined;
let nextHandlerId = 0;

/** Installs the shared terminal data listener when needed. */
function ensureDataListener(): void {
  if (dataListener) return;
  dataListener = window.swath.terminal.onData((sessionId, data) => {
    for (const handler of dataHandlers.values()) handler(sessionId, data);
  });
}

/** Installs the shared terminal exit listener when needed. */
function ensureExitListener(): void {
  if (exitListener) return;
  exitListener = window.swath.terminal.onExit((sessionId, event) => {
    for (const handler of exitHandlers.values()) handler(sessionId, event);
  });
}

/** Releases the shared data listener when unused. */
function releaseDataListener(): void {
  if (dataHandlers.size > 0) return;
  dataListener?.();
  dataListener = undefined;
}

/** Releases the shared exit listener when unused. */
function releaseExitListener(): void {
  if (exitHandlers.size > 0) return;
  exitListener?.();
  exitListener = undefined;
}

/** Subscribes to terminal data events and returns an unsubscribe function. */
export function subscribeTerminalData(handler: TerminalDataHandler): () => void {
  ensureDataListener();
  const id = nextHandlerId++;
  dataHandlers.set(id, handler);
  return () => {
    dataHandlers.delete(id);
    releaseDataListener();
  };
}

/** Subscribes to terminal exit events and returns an unsubscribe function. */
export function subscribeTerminalExit(handler: TerminalExitHandler): () => void {
  ensureExitListener();
  const id = nextHandlerId++;
  exitHandlers.set(id, handler);
  return () => {
    exitHandlers.delete(id);
    releaseExitListener();
  };
}
