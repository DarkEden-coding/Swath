import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../../shared/types";
import { addWorkspaceFromFolder, getActivePaneIdForConfig } from "./workspaceActions";
import { addView } from "../views/viewActions";
import { splitPane } from "../panes/paneActions";
import { updateSettings } from "../settings/settingsActions";

const config = (): AppConfig => ({
  version: 2,
  activeWorkspaceId: null,
  workspaces: [],
  settings: {
    fontFamily: "mono",
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    cursorStyle: "block",
    defaultShellProfileId: "sh",
    shellProfiles: [{ id: "sh", name: "sh", command: "/bin/sh", args: [] }],
    globalEnv: {},
    confirmBeforeClosingPane: false,
  },
});

describe("workspace/view/pane actions", () => {
  it("adds a workspace with an initial view and terminal pane", () => {
    const next = addWorkspaceFromFolder(config(), { canceled: false, path: "/repo", name: "repo" });
    expect(next.workspaces[0]?.views[0]?.layout.type).toBe("pane");
    expect(next.activeWorkspaceId).toBe(next.workspaces[0]?.id);
  });

  it("adds and splits views", () => {
    let next = addWorkspaceFromFolder(config(), { canceled: false, path: "/repo", name: "repo" });
    const added = addView(next, next.activeWorkspaceId ?? undefined);
    next = added.config;
    expect(next.workspaces[0]?.views).toHaveLength(2);
    const view = next.workspaces[0]!.views[0]!;
    const paneId = view.activePaneId;
    const split = splitPane(next, next.workspaces[0]!.id, view.id, paneId, "vertical").config;
    expect(split.workspaces[0]!.views[0]!.layout.type).toBe("split");
  });

  it("updates settings without dropping fields", () => {
    const next = updateSettings(config(), { fontSize: 18 });
    expect(next.settings.fontSize).toBe(18);
    expect(next.settings.fontFamily).toBe("mono");
  });

  it("returns null active pane when no workspaces", () => {
    expect(getActivePaneIdForConfig(config())).toBeNull();
  });

  it("resolves active pane id for the active workspace view", () => {
    const next = addWorkspaceFromFolder(config(), { canceled: false, path: "/repo", name: "repo" });
    expect(getActivePaneIdForConfig(next)).toBe(next.workspaces[0]?.views[0]?.activePaneId ?? null);
  });
});
