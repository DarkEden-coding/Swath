import type { AppSettings } from "./settings";
import type { Workspace } from "./workspace";
import type { PaneId, ProjectId, TaskId } from "./projects";

export interface RemoteConnection {
  id: string;
  name: string;
  /** HTTP(S) address of a Swath connector, normally a Tailscale DNS name. */
  url: string;
  /** Connector bearer token. Kept in the local app config and never returned by a connector. */
  token: string;
  machineId: string;
  platform: string;
  lastConnectedAt: number;
}

export interface AppConfig {
  version: 2;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  settings: AppSettings;
  remoteConnections?: RemoteConnection[];
}

/** Interface-local state. It is deliberately absent from the shared catalog. */
export interface LocalInterfaceState {
  interfaceId: string;
  activeProjectId: ProjectId | null;
  activeTaskId: TaskId | null;
  focusedPaneId: PaneId | null;
  /** Per-task split geometry serialized by the local interface. */
  taskLayouts: Record<TaskId, unknown>;
  drafts: Record<PaneId, string>;
  revision: number;
}

export interface FolderSelectResult {
  canceled: boolean;
  path: string | null;
  name: string | null;
}

export interface ConfirmDialogRequest {
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}
