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
import type {
  CatalogMutationRequest,
  CatalogMutationResult,
  CatalogSnapshot,
  NetworkDiscovery,
  NetworkHealth,
  NetworkMember,
} from "../types/network";
import type {
  MigrationConflict,
  MigrationConflictApproval,
  MigrationConflictProposal,
  MigrationImportRequest,
  MigrationPreview,
  MigrationStatus,
} from "../types/migration";
import type { FilesRpcRequest } from "./filesRpc";
import type { GitRpcRequest } from "./gitRpc";
import type { AskImagesRequest } from "./askImages";
import type { PiRpcRequest } from "./piRpc";
import type { TaskRpcRequest } from "./taskRpc";
import type { PiIncoming } from "./piRpc";

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
  askImagesLoad: "ask_images_load",
  filesRpc: "files_rpc",
  piRpc: "pi_rpc",
  taskRpc: "task_rpc",
  syncSnapshot: "sync_snapshot",
  syncChanges: "sync_changes",
  syncAck: "sync_ack",
  syncConflicts: "sync_conflicts",
  remoteServerStart: "remote_server_start",
  remoteServerStop: "remote_server_stop",
  remoteServerStatus: "remote_server_status",
  networkInitialize: "network_initialize",
  networkCurrent: "network_current",
  networkDiscover: "network_discover",
  networkRequestJoin: "network_request_join",
  networkJoinStatus: "network_join_status",
  networkApproveJoin: "network_approve_join",
  networkMembership: "network_membership",
  networkPromote: "network_promote",
  networkHealth: "network_health",
  catalogSnapshot: "catalog_snapshot",
  catalogMutate: "catalog_mutate",
  migrationPreview: "migration_preview",
  migrationStatus: "migration_status",
  migrationConfirm: "migration_confirm",
  migrationExport: "migration_export",
  migrationConflicts: "migration_conflicts",
  migrationEnsureResolutionJob: "migration_ensure_resolution_job",
  migrationSubmitProposal: "migration_submit_proposal",
  migrationApproveProposal: "migration_approve_proposal",
  localStateLoad: "local_state_load",
  localStateSave: "local_state_save",
} as const;

export interface RemoteServerOptions {
  bind: string;
  port: number;
  token: string;
  /** Publishes the loopback connector through Tailscale Serve on HTTPS port 443. */
  tailscaleHttps?: boolean;
  /** Exact browser origins permitted to use cookie-authenticated connector APIs. */
  allowedOrigins?: string[];
}

export interface RemoteServerStatus {
  running: boolean;
  bind?: string;
  port?: number;
  tailscaleHttps?: boolean;
  httpsUrl?: string;
  machineId: string;
  platform: string;
}

export interface RemoteHandshake {
  protocol: 2;
  machineId: string;
  name: string;
  platform: string;
  config: AppConfig;
}

export interface SyncRecord {
  taskId: string;
  paneId: string;
  executionGeneration: number;
  sessionId: string;
  sourceId: string;
  sequence: number;
  stableId: string;
  event: PiIncoming;
}

export interface SyncReply {
  status?: "synced";
  code?: "cursor_expired";
  networkId: string;
  cursor: string | null;
  records: SyncRecord[];
}

export interface RemoteFolderListing {
  path: string;
  parent: string | null;
  folders: Array<{ name: string; path: string }>;
}

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
  askImages: {
    load(request: AskImagesRequest): Promise<unknown>;
  };
  files: {
    rpc(request: FilesRpcRequest): Promise<unknown>;
  };
  tasks: { rpc(request: TaskRpcRequest): Promise<unknown> };
  pi: {
    rpc(request: PiRpcRequest): Promise<unknown>;
    /** Subscribes to stdout lines and exit notices for every pi pane. */
    onEvent(
      callback: (paneId: string, line: string | undefined, exited: boolean) => void,
    ): () => void;
  };
  sync: {
    snapshot(networkId: string): Promise<SyncReply>;
    changes(networkId: string, cursor: string | null): Promise<SyncReply>;
    ack(networkId: string, cursor: string | null): Promise<{ ok: boolean; cursor: string | null }>;
    conflicts(
      networkId: string,
    ): Promise<{ conflicts: Array<{ stableId: string; original: unknown; divergent: unknown }> }>;
  };
  network: {
    /** Returns the selected local network without creating one. */
    current(): Promise<CatalogSnapshot | null>;
    initialize(name: string): Promise<CatalogSnapshot>;
    discover(): Promise<NetworkDiscovery[]>;
    requestJoin(
      networkId: string,
      endpoint: string,
      enrollmentSecret: string,
    ): Promise<{ enrollmentId: string; state: "pending" }>;
    joinStatus(enrollmentId: string): Promise<{ state: string; networkId?: string }>;
    approveJoin(networkId: string, enrollmentId: string): Promise<void>;
    membership(networkId: string): Promise<NetworkMember[]>;
    promote(networkId: string, deviceId: string): Promise<void>;
    health(networkId: string): Promise<NetworkHealth>;
  };
  catalog: {
    snapshot(networkId: string): Promise<CatalogSnapshot>;
    mutate(request: CatalogMutationRequest): Promise<CatalogMutationResult>;
  };
  migration: {
    status(): Promise<MigrationStatus>;
    preview(operationId: string): Promise<MigrationPreview>;
    confirm(request: MigrationImportRequest): Promise<unknown>;
    /** Source JSON only; the renderer chooses a download destination. */
    export(): Promise<{ filename: string; content: string }>;
    conflicts(): Promise<MigrationConflict[]>;
    ensureResolutionJob(conflictId: string): Promise<unknown>;
    submitProposal(proposal: MigrationConflictProposal): Promise<unknown>;
    approveProposal(approval: MigrationConflictApproval): Promise<unknown>;
  };
  /** Per-interface state is local-only; browser implementations use IndexedDB, never localStorage. */
  localState: {
    load(networkId: string): Promise<{ revision: number; state: unknown } | null>;
    save(networkId: string, state: unknown, revision: number): Promise<number>;
  };
  remote: {
    connect(url: string, token: string): Promise<RemoteHandshake>;
    forget(connectionId: string): void;
    status(connectionId: string): "connected" | "connecting" | "offline";
    onStatus(
      callback: (connectionId: string, status: "connected" | "connecting" | "offline") => void,
    ): () => void;
    listFolders(connectionId: string, path?: string): Promise<RemoteFolderListing>;
    serverStart(options: RemoteServerOptions): Promise<RemoteServerStatus>;
    serverStop(): Promise<void>;
    serverStatus(): Promise<RemoteServerStatus>;
  };
}
