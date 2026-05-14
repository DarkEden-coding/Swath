import type { ComponentType, LazyExoticComponent } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../shared/types";
import type { PaneComponentProps } from "../panes/paneTypes";

export interface TabTypeRegistration {
  kind: PaneLeaf["kind"];
  label: string;
  Component: ComponentType<PaneComponentProps> | LazyExoticComponent<ComponentType<PaneComponentProps>>;
  createPaneMeta: (settings: AppSettings, cwd?: string) => Partial<Omit<PaneLeaf, "type" | "id" | "kind">>;
  createView: (title: string, cwd: string | undefined, settings: AppSettings) => WorkspaceView;
  isBusy?: (paneId: string) => Promise<boolean>;
  closePane?: (paneId: string) => void;
}
