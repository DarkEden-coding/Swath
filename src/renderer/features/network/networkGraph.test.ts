import { describe, expect, it } from "vitest";
import type { Device, NetworkMember, Task, TaskPane } from "../../../shared/types";
import { buildNetworkGraph } from "./networkGraph";

const device = (id: string): Device => ({
  id,
  networkId: "network",
  displayName: id,
  hostname: `${id}.local`,
  platform: "test",
  enrollmentId: `enroll-${id}`,
  revision: 1,
});

describe("network graph", () => {
  it("connects executors through the catalog server and derives activity state", () => {
    const devices = [device("one"), device("two"), device("three")];
    const members: NetworkMember[] = devices.map(({ id }) => ({
      deviceId: id,
      voter: id === "one",
      healthy: id !== "three",
    }));
    const tasks = [
      {
        id: "task",
        projectId: "project",
        title: "Work",
        assignedDeviceId: "one",
        executionGeneration: 1,
        lifecycle: "active",
        paneOrder: ["pane"],
        revision: 1,
        createdAt: 1,
      },
    ] satisfies Task[];
    const panes = [
      { id: "pane", taskId: "task", kind: "piAgent", title: null, sessionId: null, revision: 1 },
    ] satisfies TaskPane[];

    const graph = buildNetworkGraph(devices, members, tasks, panes, { pane: "running" });
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.every(({ source }) => source.device.id === "one")).toBe(true);
    expect(graph.nodes.map(({ state }) => state)).toEqual(["running", "available", "offline"]);
    expect(graph.edges.filter(({ healthy }) => healthy)).toHaveLength(1);
  });

  it("does not invent peer links when membership has no catalog server", () => {
    const devices = [device("one"), device("two"), device("three")];
    const members: NetworkMember[] = devices.map(({ id }) => ({
      deviceId: id,
      voter: false,
      healthy: true,
    }));

    const graph = buildNetworkGraph(devices, members, [], [], {});

    expect(graph.edges).toEqual([]);
  });
});
