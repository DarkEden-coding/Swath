import type { AppSettings, PaneLeaf, Workspace, WorkspaceView } from "../../../shared/types";

export interface PaneComponentProps {
  workspace: Workspace;
  view: WorkspaceView;
  pane: PaneLeaf;
  settings: AppSettings;
}
