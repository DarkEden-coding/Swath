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

/** Creates a deterministic server-centered view from membership and ephemeral agent activity. */
export function buildNetworkGraph(
  devices: Device[],
  members: NetworkMember[],
  tasks: Task[],
  panes: TaskPane[],
  activity: Record<string, PiPaneActivity>,
): NetworkGraph {
  const memberByDevice = new Map(members.map((member) => [member.deviceId, member]));
  const count = devices.length;
  const nodes = devices.map((device): NetworkGraphNode => {
    const member = memberByDevice.get(device.id) ?? null;
    const assigned = tasks.filter(
      (task) => task.assignedDeviceId === device.id && task.lifecycle === "active",
    );
    const taskIds = new Set(assigned.map((task) => task.id));
    const running = panes.filter(
      (pane) => taskIds.has(pane.taskId) && activity[pane.id] === "running",
    ).length;
    const healthy = member?.healthy === true;
    return {
      device,
      member,
      healthy,
      running,
      activeTasks: assigned.length,
      state: running > 0 ? "running" : healthy ? "available" : "offline",
      x: 400,
      y: 220,
    };
  });

  // The catalog has one fixed server. Keep it at the center and arrange executor
  // devices around it so the diagram does not imply peer-to-peer replication.
  const serverIndex = nodes.findIndex((node) => node.member?.voter === true);
  const centerIndex = serverIndex >= 0 ? serverIndex : count === 1 ? 0 : -1;
  if (centerIndex >= 0) {
    nodes[centerIndex]!.x = 400;
    nodes[centerIndex]!.y = 220;
  }
  const clients = nodes.filter((_, index) => index !== centerIndex);
  const radiusX = clients.length <= 2 ? 190 : 285;
  const radiusY = clients.length <= 2 ? 95 : 155;
  clients.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / clients.length;
    node.x = 400 + Math.cos(angle) * radiusX;
    node.y = 220 + Math.sin(angle) * radiusY;
  });

  const edges: NetworkGraphEdge[] = [];
  if (centerIndex >= 0) {
    const server = nodes[centerIndex]!;
    for (const client of clients) {
      edges.push({
        source: server,
        target: client,
        healthy: server.healthy && client.healthy,
      });
    }
  }
  return { nodes, edges };
}
