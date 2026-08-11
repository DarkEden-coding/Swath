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
} from "../types";
import type { FilesRpcRequest } from "./filesRpc";
import type { GitRpcRequest } from "./gitRpc";
import type { ImageRpcRequest } from "./imageRpc";
import type { PiRpcRequest } from "./piRpc";

/** Rust command identifiers used by the renderer's Tauri transport. */
export const TauriCommands = {
  configLoad: "config_load",
  configSave: "config_save",
  dialogSelectFolder: "dialog_select_folder",
  dialogConfirm: "dialog_confirm",
  clipboardReadForTerminal: "clipboard_read_for_terminal",
  clipboardWriteText: "clipboard_write_text",
  browserOpenExternal: "browser_open_external",
  permissionsEnsureTerminalPaste: "permissions_ensure_terminal_paste",
  terminalCreate: "terminal_create",
  terminalWrite: "terminal_write",
  terminalResize: "terminal_resize",
  terminalKill: "terminal_kill",
  terminalAttach: "terminal_attach",
  terminalRestart: "terminal_restart",
  terminalReplay: "terminal_replay",
  terminalSetStreaming: "terminal_set_streaming",
  terminalIsBusy: "terminal_is_busy",
  gitRpc: "git_rpc",
  imageRpc: "image_rpc",
  filesRpc: "files_rpc",
  piRpc: "pi_rpc",
} as const;

/** Stable host API exposed as `window.swath` in both Tauri and browser development. */
export interface SwathApi {
  platform: NodeJS.Platform | string;
  config: { load(): Promise<AppConfig>; save(config: AppConfig): Promise<void> };
  dialog: {
    selectFolder(): Promise<FolderSelectResult>;
    confirm(request: ConfirmDialogRequest): Promise<boolean>;
  };
  clipboard: {
    readForTerminal(): Promise<TerminalClipboardPayload>;
    writeText(text: string): Promise<void>;
  };
  browser: { openExternal(url: string): Promise<void> };
  permissions: { ensureTerminalPaste(): Promise<TerminalPastePermissionStatus> };
  terminal: {
    create(request: TerminalSessionStartRequest): Promise<void>;
    write(sessionId: string, data: string): Promise<void>;
    resize(request: PtyResizeRequest): void;
    kill(sessionId: string): void;
    attach(request: TerminalSessionAttachRequest): Promise<TerminalSessionStatus | undefined>;
    restart(sessionId: string): Promise<TerminalSessionStatus | undefined>;
    replay(sessionId: string): Promise<TerminalSessionStatus | undefined>;
    setStreaming(sessionId: string, enabled: boolean): void;
    isBusy(sessionId: string): Promise<boolean>;
    onData(callback: (sessionId: string, data: string) => void): () => void;
    onExit(
      callback: (sessionId: string, event: { exitCode: number; signal?: number }) => void,
    ): () => void;
  };
  app: { onCommand(callback: (command: string) => void): () => void };
  git: {
    rpc(request: GitRpcRequest): Promise<unknown>;
    onData(callback: (runId: string, data: string) => void): () => void;
  };
  image: {
    rpc(request: ImageRpcRequest): Promise<unknown>;
  };
  files: {
    rpc(request: FilesRpcRequest): Promise<unknown>;
  };
  pi: {
    rpc(request: PiRpcRequest): Promise<unknown>;
    /** Subscribes to stdout lines and exit notices for every pi pane. */
    onEvent(
      callback: (paneId: string, line: string | undefined, exited: boolean) => void,
    ): () => void;
  };
}
