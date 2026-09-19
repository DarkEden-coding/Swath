export type TaskRpcRequest =
  | { op: "createProject" | "importProject"; networkId: string; name: string; sourcePath: string }
  | {
      op: "createTask";
      projectId: string;
      title: string;
      deviceId: string;
      baseCommit?: string;
    }
  | { op: "listCatalog"; networkId: string }
  | { op: "renameProject"; projectId: string; name: string }
  | { op: "renameTask"; taskId: string; title: string }
  | { op: "reorderTasks"; projectId: string; taskIds: string[] }
  | { op: "completeTask"; taskId: string }
  | { op: "reorderPanes"; taskId: string; paneIds: string[] }
  | { op: "createPane"; taskId: string; kind: string; title?: string }
  | { op: "removePane"; taskId: string; paneId: string }
  | { op: "retryProvision" | "getTask" | "cleanupPreview" | "restoreTask"; taskId: string }
  | { op: "approvePreview"; taskId: string; port: number }
  | {
      op: "transferPreflight";
      taskId: string;
      destinationDeviceId: string;
      operationId?: string;
      exclusions?: string[];
      secretApproval?: true;
    }
  | { op: "transferConfirm"; operationId: string; agentsStopped: true; serverConfirmed: true }
  | { op: "transferCancel"; operationId: string }
  | {
      op: "cleanupConfirm";
      taskId: string;
      previewToken: string;
      agentsStopped: true;
      serverConfirmed: true;
    };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
/** Validates renderer task requests before they cross the host boundary. */
export function parseTaskRpcRequest(raw: unknown): TaskRpcRequest | null {
  if (!record(raw) || typeof raw.op !== "string") return null;
  if (raw.op === "createProject" || raw.op === "importProject") {
    const networkId = text(raw.networkId),
      name = text(raw.name),
      sourcePath = text(raw.sourcePath);
    return networkId && name && sourcePath ? { op: raw.op, networkId, name, sourcePath } : null;
  }
  if (raw.op === "createTask") {
    const projectId = text(raw.projectId),
      title = text(raw.title),
      deviceId = text(raw.deviceId);
    const baseCommit = raw.baseCommit === undefined ? undefined : text(raw.baseCommit);
    if (
      !projectId ||
      !title ||
      !deviceId ||
      (raw.baseCommit !== undefined && !baseCommit) ||
      raw.allowOfflineDevice !== undefined
    )
      return null;
    return { op: "createTask", projectId, title, deviceId, ...(baseCommit ? { baseCommit } : {}) };
  }
  if (raw.op === "listCatalog") {
    const networkId = text(raw.networkId);
    return networkId ? { op: raw.op, networkId } : null;
  }
  if (raw.op === "renameProject") {
    const projectId = text(raw.projectId),
      name = text(raw.name);
    return projectId && name ? { op: raw.op, projectId, name } : null;
  }
  if (raw.op === "renameTask") {
    const taskId = text(raw.taskId),
      title = text(raw.title);
    return taskId && title ? { op: raw.op, taskId, title } : null;
  }
  if (raw.op === "completeTask") {
    const taskId = text(raw.taskId);
    return taskId ? { op: raw.op, taskId } : null;
  }
  if (raw.op === "reorderTasks" || raw.op === "reorderPanes") {
    const key = raw.op === "reorderTasks" ? "taskIds" : "paneIds";
    const value = raw[key];
    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && !!item.trim())
      : [];
    if (!ids.length) return null;
    if (raw.op === "reorderTasks") {
      const projectId = text(raw.projectId);
      return projectId ? { op: raw.op, projectId, taskIds: ids } : null;
    }
    const taskId = text(raw.taskId);
    return taskId ? { op: raw.op, taskId, paneIds: ids } : null;
  }
  if (raw.op === "createPane") {
    const taskId = text(raw.taskId),
      kind = text(raw.kind),
      title = raw.title === undefined ? undefined : text(raw.title);
    return taskId && kind && (raw.title === undefined || title)
      ? { op: raw.op, taskId, kind, ...(title ? { title } : {}) }
      : null;
  }
  if (raw.op === "removePane") {
    const taskId = text(raw.taskId),
      paneId = text(raw.paneId);
    return taskId && paneId ? { op: raw.op, taskId, paneId } : null;
  }
  if (
    raw.op === "retryProvision" ||
    raw.op === "getTask" ||
    raw.op === "cleanupPreview" ||
    raw.op === "restoreTask"
  ) {
    const taskId = text(raw.taskId);
    return taskId ? { op: raw.op, taskId } : null;
  }
  if (raw.op === "approvePreview") {
    const taskId = text(raw.taskId),
      port = raw.port;
    return taskId && typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
      ? { op: raw.op, taskId, port }
      : null;
  }
  if (raw.op === "transferPreflight") {
    const taskId = text(raw.taskId),
      destinationDeviceId = text(raw.destinationDeviceId),
      operationId = raw.operationId === undefined ? undefined : text(raw.operationId);
    const secretApproval = raw.secretApproval === true ? true : undefined;
    const exclusions =
      raw.exclusions === undefined
        ? undefined
        : Array.isArray(raw.exclusions) && raw.exclusions.every((v) => typeof v === "string")
          ? raw.exclusions
          : null;
    return taskId &&
      destinationDeviceId &&
      (raw.operationId === undefined || operationId) &&
      exclusions !== null
      ? {
          op: raw.op,
          taskId,
          destinationDeviceId,
          ...(operationId ? { operationId } : {}),
          ...(exclusions ? { exclusions } : {}),
          ...(secretApproval ? { secretApproval } : {}),
        }
      : null;
  }
  if (raw.op === "transferConfirm") {
    const operationId = text(raw.operationId);
    return operationId && raw.agentsStopped === true && raw.serverConfirmed === true
      ? { op: raw.op, operationId, agentsStopped: true, serverConfirmed: true }
      : null;
  }
  if (raw.op === "transferCancel") {
    const operationId = text(raw.operationId);
    return operationId ? { op: raw.op, operationId } : null;
  }
  if (raw.op === "cleanupConfirm") {
    const taskId = text(raw.taskId),
      previewToken = text(raw.previewToken);
    return taskId && previewToken && raw.agentsStopped === true && raw.serverConfirmed === true
      ? { op: raw.op, taskId, previewToken, agentsStopped: true, serverConfirmed: true }
      : null;
  }
  return null;
}
