import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../../shared/types";
import {
  addToGroup,
  createGroup,
  detachFromGroup,
  dissolveGroup,
  groupPathsFor,
  isGroupRoot,
  membersOf,
} from "./groupActions";
import { addWorkspaceFromFolder, moveWorkspace, removeWorkspace } from "./workspaceActions";

const emptyConfig = (): AppConfig => ({
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

/** A configuration holding one project per given name, at `/<name>`. */
function withProjects(...names: string[]): AppConfig {
  return names.reduce(
    (config, name) => addWorkspaceFromFolder(config, { canceled: false, path: `/${name}`, name }),
    emptyConfig(),
  );
}

const idOf = (config: AppConfig, name: string): string =>
  config.workspaces.find((workspace) => workspace.name === name)!.id;

const names = (config: AppConfig): string[] => config.workspaces.map((workspace) => workspace.name);

describe("project groups", () => {
  it("creates a group root owning a shared agent view", () => {
    const config = withProjects("api", "web");
    const { config: next, rootId } = createGroup(config, [
      idOf(config, "api"),
      idOf(config, "web"),
    ]);
    const root = next.workspaces.find((workspace) => workspace.id === rootId)!;

    expect(root.name).toBe("api + web");
    expect(isGroupRoot(root)).toBe(true);
    expect(root.views[0]?.layout).toMatchObject({ type: "pane", kind: "piAgent" });
    expect(membersOf(next, root.id).map((member) => member.name)).toEqual(["api", "web"]);
    // The root leads its block so the sidebar can render members underneath it.
    expect(names(next)).toEqual(["api + web", "api", "web"]);
  });

  it("gives a group agent every member path and leaves project agents alone", () => {
    const config = withProjects("api", "web");
    const { config: next, rootId } = createGroup(config, [
      idOf(config, "api"),
      idOf(config, "web"),
    ]);

    expect(groupPathsFor(next, rootId!)).toEqual(["/api", "/web"]);
    expect(groupPathsFor(next, idOf(next, "api"))).toEqual([]);
  });

  it("keeps a joined project next to its group and tracks the primary folder", () => {
    let config = withProjects("api", "web", "docs");
    const created = createGroup(config, [idOf(config, "api"), idOf(config, "web")]);
    config = addToGroup(created.config, idOf(created.config, "docs"), created.rootId!);

    expect(names(config)).toEqual(["api + web", "api", "web", "docs"]);
    expect(config.workspaces[0]!.path).toBe("/api");
  });

  it("dissolves a group that drops below two projects, keeping the projects", () => {
    const config = withProjects("api", "web");
    const created = createGroup(config, [idOf(config, "api"), idOf(config, "web")]);
    const next = detachFromGroup(created.config, idOf(created.config, "web"));

    expect(names(next)).toEqual(["api", "web"]);
    expect(next.workspaces.every((workspace) => workspace.groupId === undefined)).toBe(true);
  });

  it("breaking up a group keeps its projects", () => {
    const config = withProjects("api", "web");
    const created = createGroup(config, [idOf(config, "api"), idOf(config, "web")]);

    expect(names(dissolveGroup(created.config, created.rootId!))).toEqual(["api", "web"]);
    expect(names(removeWorkspace(created.config, created.rootId!))).toEqual(["api", "web"]);
  });

  it("removing a member project removes only that project", () => {
    let config = withProjects("api", "web", "docs");
    const created = createGroup(config, [idOf(config, "api"), idOf(config, "web")]);
    config = addToGroup(created.config, idOf(created.config, "docs"), created.rootId!);
    const next = removeWorkspace(config, idOf(config, "web"));

    expect(names(next)).toEqual(["api + web", "api", "docs"]);
  });

  it("dragging a group header carries its members", () => {
    let config = withProjects("api", "web", "docs");
    const created = createGroup(config, [idOf(config, "api"), idOf(config, "web")]);
    config = created.config;
    expect(names(config)).toEqual(["api + web", "api", "web", "docs"]);

    expect(names(moveWorkspace(config, 0, 3))).toEqual(["docs", "api + web", "api", "web"]);
  });

  it("dragging a project into a group's block joins the group, and out of it leaves", () => {
    let config = withProjects("api", "web", "docs");
    const created = createGroup(config, [idOf(config, "api"), idOf(config, "web")]);
    config = created.config;

    const joined = moveWorkspace(config, 3, 2);
    expect(membersOf(joined, created.rootId!).map((member) => member.name)).toEqual([
      "api",
      "docs",
      "web",
    ]);

    const left = moveWorkspace(joined, 1, 0);
    expect(left.workspaces.find((workspace) => workspace.name === "api")!.groupId).toBeUndefined();
    expect(names(left)).toEqual(["api", "api + web", "docs", "web"]);
  });
});
