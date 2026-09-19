import type { Device, NetworkMember, Task, TaskPane } from "../../../shared/types";
import type { PiPaneActivity } from "../tabTypes/piAgent/piActivity";

export interface NetworkGraphNode {
  device: Device;
  member: NetworkMember | null;
  healthy: boolean;
  running: number;
  activeTasks: number;
  state: "running" | "available" | "offline";
  x: number;
  y: number;
}

export interface NetworkGraphEdge {
  source: NetworkGraphNode;
  target: NetworkGraphNode;
  healthy: boolean;
}

export interface NetworkGraph {
  nodes: NetworkGraphNode[];
  edges: NetworkGraphEdge[];
}

/** Creates a deterministic circular mesh from durable membership and ephemeral agent activity. */
export function buildNetworkGraph(
  devices: Device[],
  members: NetworkMember[],
  tasks: Task[],
  panes: TaskPane[],
  activity: Record<string, PiPaneActivity>,
): NetworkGraph {
  const memberByDevice = new Map(members.map((member) => [member.deviceId, member]));
  const count = devices.length;
  const nodes = devices.map((device, index): NetworkGraphNode => {
    const member = memberByDevice.get(device.id) ?? null;
    const assigned = tasks.filter(
      (task) => task.assignedDeviceId === device.id && task.lifecycle === "active",
    );
    const taskIds = new Set(assigned.map((task) => task.id));
    const running = panes.filter(
      (pane) => taskIds.has(pane.taskId) && activity[pane.id] === "running",
    ).length;
    const angle = count === 1 ? -Math.PI / 2 : -Math.PI / 2 + (index * Math.PI * 2) / count;
    const radiusX = count <= 2 ? 190 : 285;
    const radiusY = count <= 2 ? 95 : 155;
    const healthy = member?.healthy === true;
    return {
      device,
      member,
      healthy,
      running,
      activeTasks: assigned.length,
      state: running > 0 ? "running" : healthy ? "available" : "offline",
      x: count === 1 ? 400 : 400 + Math.cos(angle) * radiusX,
      y: count === 1 ? 220 : 220 + Math.sin(angle) * radiusY,
    };
  });
  const edges: NetworkGraphEdge[] = [];
  for (let source = 0; source < nodes.length; source += 1)
    for (let target = source + 1; target < nodes.length; target += 1)
      edges.push({
        source: nodes[source]!,
        target: nodes[target]!,
        healthy: nodes[source]!.healthy && nodes[target]!.healthy,
      });
  return { nodes, edges };
}
