import type { AppSettings } from "./settings";
import type { Workspace } from "./workspace";

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
