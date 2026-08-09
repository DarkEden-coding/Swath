import type {
  AppSettings,
  PaneKind,
  PaneLeaf,
  ShellProfile,
  WorkspaceView,
} from "../../../shared/types";
import { createId } from "../../utils/ids";
import { createPaneNode } from "../layout/layoutTree";

/** Non-UI description used by domain actions when constructing persisted panes. */
export interface PaneKindMetadata {
  kind: PaneKind;
  label: string;
  createPaneMeta(settings: AppSettings, cwd?: string): Partial<Omit<PaneLeaf, "type" | "id">>;
}

function shellFor(settings: AppSettings): ShellProfile | null {
  return (
    settings.shellProfiles.find((profile) => profile.id === settings.defaultShellProfileId) ??
    settings.shellProfiles[0] ??
    null
  );
}

const metadata: Record<PaneKind, PaneKindMetadata> = {
  terminal: {
    kind: "terminal",
    label: "Terminal",
    createPaneMeta(settings, cwd) {
      const shellProfile = shellFor(settings);
      return {
        kind: "terminal",
        cwd,
        shellProfile,
        env: { ...(settings.globalEnv ?? {}) },
        metadata: {
          cwd,
          shellProfileId: shellProfile?.id,
          shellProfile,
          env: { ...(settings.globalEnv ?? {}) },
        },
      };
    },
  },
  gitManager: {
    kind: "gitManager",
    label: "Source Control",
    createPaneMeta(_settings, cwd) {
      return {
        kind: "gitManager",
        cwd,
        title: "Source Control",
        metadata: { cwd, title: "Source Control" },
      };
    },
  },
  imagePreview: {
    kind: "imagePreview",
    label: "Image Preview",
    createPaneMeta(_settings, cwd) {
      return {
        kind: "imagePreview",
        cwd,
        title: "Image Preview",
        metadata: { cwd, title: "Image Preview" },
      };
    },
  },
  piAgent: {
    kind: "piAgent",
    label: "Pi Agent",
    createPaneMeta(_settings, cwd) {
      return {
        kind: "piAgent",
        cwd,
        title: "pi",
        metadata: { cwd, title: "pi" },
      };
    },
  },
};

export function getPaneKindMetadata(kind: PaneKind): PaneKindMetadata {
  return metadata[kind];
}

export function createPaneMeta(
  kind: PaneKind,
  settings: AppSettings,
  cwd?: string,
): Partial<Omit<PaneLeaf, "type" | "id">> {
  return getPaneKindMetadata(kind).createPaneMeta(settings, cwd);
}

/** Creates the stable persisted view shape without consulting React registrations. */
export function createPaneView(
  kind: PaneKind,
  title: string,
  cwd: string | undefined,
  settings: AppSettings,
): WorkspaceView {
  const pane = createPaneNode(undefined, createPaneMeta(kind, settings, cwd));
  return {
    id: createId("view"),
    type: "workspace-view",
    title,
    layout: pane,
    activePaneId: pane.id,
  };
}
