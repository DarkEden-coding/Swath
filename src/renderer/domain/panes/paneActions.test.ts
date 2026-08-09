import { describe, expect, it } from "vitest";
import type { AppConfig, LayoutNode } from "../../../shared/types";
import { createPaneLeaf } from "../layout/layoutTree";
import { imagePreviewTitleFromPath, upsertImagePreviewPane } from "./paneActions";

function baseConfig(layout: LayoutNode): AppConfig {
  return {
    version: 2,
    activeWorkspaceId: "ws-1",
    workspaces: [
      {
        id: "ws-1",
        name: "Demo",
        path: "/tmp/demo",
        createdAt: 0,
        updatedAt: 0,
        activeViewId: "view-1",
        views: [
          {
            id: "view-1",
            title: "Main",
            activePaneId: "pane-term",
            layout,
          },
        ],
      },
    ],
    settings: {
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      defaultShellProfileId: "zsh",
      shellProfiles: [{ id: "zsh", name: "zsh", command: "/bin/zsh", args: ["-l"] }],
      globalEnv: {},
      confirmBeforeClosingPane: false,
    },
  };
}

describe("upsertImagePreviewPane", () => {
  it("derives a basename title", () => {
    expect(imagePreviewTitleFromPath("/tmp/demo/a/b.png")).toBe("b.png");
  });

  it("splits vertically when no preview exists", () => {
    const config = baseConfig(createPaneLeaf("terminal", "pane-term", { cwd: "/tmp/demo" }));
    const result = upsertImagePreviewPane(
      config,
      "ws-1",
      "view-1",
      "pane-term",
      "/tmp/demo/shot.png",
    );
    const view = result.config.workspaces[0]?.views[0];
    expect(view?.layout.type).toBe("split");
    expect(result.activePaneId).toBeTruthy();
    expect(view?.activePaneId).toBe(result.activePaneId);
    if (view?.layout.type === "split") {
      expect(view.layout.direction).toBe("vertical");
      expect(view.layout.second.type === "pane" && view.layout.second.kind).toBe("imagePreview");
      expect(
        view.layout.second.type === "pane" ? view.layout.second.metadata?.imagePath : null,
      ).toBe("/tmp/demo/shot.png");
    }
  });

  it("reuses an existing preview and activates it", () => {
    const layout: LayoutNode = {
      type: "split",
      id: "split-1",
      direction: "vertical",
      ratio: 0.5,
      first: createPaneLeaf("terminal", "pane-term"),
      second: createPaneLeaf("imagePreview", "pane-img", {
        metadata: { imagePath: "/tmp/demo/old.png", imageTitle: "old.png", title: "old.png" },
      }),
    };
    const result = upsertImagePreviewPane(
      baseConfig(layout),
      "ws-1",
      "view-1",
      "pane-term",
      "/tmp/demo/new.png",
      "new.png",
    );
    const view = result.config.workspaces[0]?.views[0];
    expect(result.activePaneId).toBe("pane-img");
    expect(view?.activePaneId).toBe("pane-img");
    if (view?.layout.type === "split" && view.layout.second.type === "pane") {
      expect(view.layout.second.metadata?.imagePath).toBe("/tmp/demo/new.png");
      expect(view.layout.second.metadata?.imageTitle).toBe("new.png");
      expect(view.layout.second.title).toBe("new.png");
    }
  });
});
