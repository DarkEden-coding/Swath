import type { AppSettings } from "./settings";
import type { Workspace } from "./workspace";

export interface AppConfig {
  version: 2;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  settings: AppSettings;
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
