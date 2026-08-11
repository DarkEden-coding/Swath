import { describe, expect, it } from "vitest";
import type { AppConfig, LayoutNode, PaneKind, Workspace } from "../../../shared/types";
import { sanitizeConfig } from "./configSanitizer";

const settings = (): AppConfig["settings"] => ({
  fontFamily: "mono",
  fontSize: 13,
  lineHeight: 1.1,
  cursorBlink: true,
  cursorStyle: "block",
  defaultShellProfileId: "sh",
  shellProfiles: [{ id: "sh", name: "sh", command: "/bin/sh", args: [] }],
  globalEnv: {},
  confirmBeforeClosingPane: false,
});

const pane = (id: string, kind: string): LayoutNode =>
  ({ type: "pane", id, kind: kind as PaneKind }) as LayoutNode;

const split = (id: string, first: LayoutNode, second: LayoutNode): LayoutNode => ({
  type: "split",
  id,
  direction: "vertical",
  ratio: 0.5,
  first,
  second,
});

const workspace = (views: Workspace["views"], activeViewId = views[0]?.id ?? ""): Workspace => ({
  id: "ws",
  name: "ws",
  path: "/repo",
  views,
  activeViewId,
  createdAt: 0,
  updatedAt: 0,
});

const config = (workspaces: Workspace[]): AppConfig => ({
  version: 2,
  activeWorkspaceId: workspaces[0]?.id ?? null,
  workspaces,
  settings: settings(),
});

describe("sanitizeConfig", () => {
  it("leaves a supported configuration untouched", () => {
    const input = config([
      workspace([
        { id: "v1", title: "Terminal", layout: pane("p1", "terminal"), activePaneId: "p1" },
      ]),
    ]);
    const result = sanitizeConfig(input);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(input);
  });

  it("drops a view whose only pane has an unknown kind", () => {
    const result = sanitizeConfig(
      config([
        workspace(
          [
            { id: "v1", title: "Terminal", layout: pane("p1", "terminal"), activePaneId: "p1" },
            { id: "v2", title: "Image", layout: pane("p2", "imagePreview"), activePaneId: "p2" },
          ],
          "v2",
        ),
      ]),
    );
    expect(result.changed).toBe(true);
    expect(result.removedKinds).toEqual(["imagePreview"]);
    expect(result.config.workspaces[0]!.views.map((view) => view.id)).toEqual(["v1"]);
    expect(result.config.workspaces[0]!.activeViewId).toBe("v1");
  });

  it("collapses a split when one side is unsupported and repairs the active pane", () => {
    const result = sanitizeConfig(
      config([
        workspace([
          {
            id: "v1",
            title: "Split",
            layout: split("s1", pane("p1", "terminal"), pane("p2", "imagePreview")),
            activePaneId: "p2",
          },
        ]),
      ]),
    );
    const view = result.config.workspaces[0]!.views[0]!;
    expect(view.layout).toEqual(pane("p1", "terminal"));
    expect(view.activePaneId).toBe("p1");
  });

  it("empties a workspace whose views are all unsupported", () => {
    const result = sanitizeConfig(
      config([
        workspace([
          { id: "v1", title: "Image", layout: pane("p1", "imagePreview"), activePaneId: "p1" },
        ]),
      ]),
    );
    expect(result.config.workspaces[0]!.views).toEqual([]);
    expect(result.config.workspaces[0]!.activeViewId).toBe("");
  });
});
