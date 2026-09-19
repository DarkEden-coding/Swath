import type { AppSettings, PaneLeaf, Workspace, WorkspaceView } from "../../../shared/types";

/** Executor authority for a task pane. `cwd` is display compatibility only; host resolves it. */
export interface TaskExecutionContext {
  /** Cache partition; executor remains authoritative for task ownership. */
  networkId?: string;
  taskId: string;
  executionGeneration: number;
  /** Historical/completed views hydrate replicated history but never start an executor. */
  readOnly?: boolean;
  cwd: string;
}

export interface PaneComponentProps {
  workspace: Workspace;
  view: WorkspaceView;
  pane: PaneLeaf;
  settings: AppSettings;
  taskExecution?: TaskExecutionContext;
}
