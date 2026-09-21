import { describe, expect, it } from "vitest";
import type { Project, Workspace } from "../../../shared/types";
import { orderProjectRows } from "./TaskProjectSidebar";

const project = (id: string, name: string): Project => ({
  id,
  name,
  repositorySource: null,
  defaultBranch: "main",
  taskOrder: [],
  revision: 1,
  createdAt: 1,
});

const workspace = (id: string, name: string, fields: Partial<Workspace> = {}): Workspace => ({
  id,
  name,
  path: `/${name}`,
  views: [],
  activeViewId: "",
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

describe("grouped task projects", () => {
  const group = workspace("group", "api + web", { isGroupRoot: true });
  const api = workspace("api", "api", { groupId: group.id });
  const web = workspace("web", "web", { groupId: group.id });
  const other = workspace("other", "other");
  const workspaces = [group, api, web, other];
  const projects = workspaces.map(({ id, name }) => project(id, name));

  it("renders members beneath an expanded group", () => {
    expect(
      orderProjectRows(projects, workspaces, new Set()).map((row) => row.project.name),
    ).toEqual(["api + web", "api", "web", "other"]);
  });

  it("hides members rather than moving them outside a collapsed group", () => {
    expect(
      orderProjectRows(projects, workspaces, new Set([group.id])).map((row) => row.project.name),
    ).toEqual(["api + web", "other"]);
  });
});
