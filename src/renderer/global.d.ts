declare module "@tauri-apps/api/core" {
  export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare module "@tauri-apps/api/event" {
  export interface Event<T> {
    payload: T;
  }

  export function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<() => void>;
}

declare namespace JSX {
  type Element = import("react").ReactElement;
}

interface SwathApi {
  platform: NodeJS.Platform | string;
  config: {
    load: () => Promise<import("../shared/types").AppConfig>;
    save: (config: import("../shared/types").AppConfig) => Promise<void>;
  };
  dialog: {
    selectFolder: () => Promise<import("../shared/types").FolderSelectResult>;
    confirm: (request: import("../shared/types").ConfirmDialogRequest) => Promise<boolean>;
  };
  clipboard: {
    readForTerminal: () => Promise<import("../shared/types").TerminalClipboardPayload>;
    writeText: (text: string) => Promise<void>;
  };
  browser: {
    openExternal: (url: string) => Promise<void>;
  };
  permissions: {
    ensureTerminalPaste: () => Promise<import("../shared/types").TerminalPastePermissionStatus>;
  };
  terminal: {
    create: (request: import("../shared/types").TerminalSessionStartRequest) => void;
    write: (sessionId: string, data: string) => void;
    resize: (request: import("../shared/types").PtyResizeRequest) => void;
    kill: (sessionId: string) => void;
    attach: (request: import("../shared/types").TerminalSessionAttachRequest) => Promise<import("../shared/types").TerminalSessionStatus | undefined>;
    restart: (sessionId: string) => Promise<import("../shared/types").TerminalSessionStatus | undefined>;
    replay: (sessionId: string) => Promise<import("../shared/types").TerminalSessionStatus | undefined>;
    setStreaming: (sessionId: string, enabled: boolean) => void;
    isBusy: (sessionId: string) => Promise<boolean>;
    onData: (callback: (sessionId: string, data: string) => void) => () => void;
    onExit: (callback: (sessionId: string, event: { exitCode: number; signal?: number }) => void) => () => void;
  };
  app: {
    onCommand: (callback: (command: string) => void) => () => void;
  };
  git: {
    rpc: (request: import("../shared/ipc/gitRpc").GitRpcRequest) => Promise<unknown>;
  };
}

interface Window {
  swath: SwathApi;
}
