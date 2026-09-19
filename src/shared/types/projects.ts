import type { DeviceId } from "./network";

/** Opaque shared catalog IDs. They must not encode a local path or hostname. */
export type ProjectId = string;
export type TaskId = string;
export type PaneId = string;
export type SessionId = string;

export interface Project {
  id: ProjectId;
  name: string;
  repositorySource: string | null;
  defaultBranch: string;
  taskOrder: TaskId[];
  revision: number;
  createdAt: number;
  tombstonedAt?: number;
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  assignedDeviceId: DeviceId;
  executionGeneration: number;
  lifecycle: "active" | "completed";
  paneOrder: PaneId[];
  revision: number;
  createdAt: number;
  tombstonedAt?: number;
}

/** Shared membership only; split geometry belongs to a local interface. */
export interface TaskPane {
  id: PaneId;
  taskId: TaskId;
  kind: string;
  title: string | null;
  sessionId: SessionId | null;
  revision: number;
  tombstonedAt?: number;
}

/** A task path is executor-local data, never project identity. */
export interface DeviceTaskPath {
  taskId: TaskId;
  deviceId: DeviceId;
  path: string;
  revision: number;
}
