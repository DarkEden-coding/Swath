import { useEffect, useMemo, useState } from "react";
import type { LayoutNode, PaneKind, Workspace, WorkspaceView } from "../../../shared/types";
import { useTaskStore } from "../../state/taskStore";
import { useConfigStore } from "../../state/configStore";
import { LayoutRenderer } from "../panes/components/LayoutRenderer";
import { TaskTabBar } from "../views/components/ViewTabBar";

/** Minimal legacy shape required by registered pane renderers; task ownership stays separate. */
export function taskRendererProjection(
  task: { id: string; title: string },
  panes: { id: string; kind: string; title: string | null; sessionId?: string | null }[],
  cwd: string,
  focusedPaneId?: string | null,
): { workspace: Workspace; view: WorkspaceView } {
  const leaves = panes.map((pane) => ({
    type: "pane" as const,
    id: pane.id,
    kind: pane.kind as PaneKind,
    title: pane.title ?? undefined,
    cwd,
    ...(pane.sessionId ? { metadata: { piSessionFile: pane.sessionId } } : {}),
  }));
  const layout = leaves.slice(1).reduce<LayoutNode>(
    (first, second, index) => ({
      type: "split",
      id: `${task.id}:split:${index}`,
      direction: "vertical",
      ratio: 0.5,
      first,
      second,
    }),
    leaves[0] ?? { type: "pane", id: `${task.id}:empty`, kind: "terminal", cwd },
  );
  const view: WorkspaceView = {
    id: `task:${task.id}`,
    type: "workspace-view",
    title: task.title,
    layout,
    activePaneId:
      leaves.find((pane) => pane.id === focusedPaneId)?.id ?? leaves[0]?.id ?? `${task.id}:empty`,
  };
  return {
    workspace: {
      id: `task:${task.id}`,
      name: task.title,
      path: cwd,
      views: [view],
      activeViewId: view.id,
      createdAt: 0,
      updatedAt: 0,
    },
    view,
  };
}

function rpcOk(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === true;
}

export function CreateTaskDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { catalog, devices, local, networkId, refresh } = useTaskStore();
  const project = catalog.projects.find((item) => item.id === local.activeProjectId);
  const lastTask = [...(project?.taskOrder ?? [])]
    .reverse()
    .map((id) => catalog.tasks.find((task) => task.id === id))
    .find(Boolean);
  const [title, setTitle] = useState("");
  const [deviceId, setDeviceId] = useState(lastTask?.assignedDeviceId ?? "");
  const [branch, setBranch] = useState(project?.defaultBranch ?? "");
  const [error, setError] = useState<string | null>(null);
  const online = new Set(devices.map((device) => device.id));
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create task"
      className="fixed inset-0 z-[120] grid place-items-center bg-black/50"
    >
      <form
        className="w-[360px] rounded-lg border border-swath-border bg-swath-panel p-4 shadow-swath"
        onSubmit={(event) => {
          event.preventDefault();
          if (!project || !networkId || !title.trim() || !deviceId) return;
          void window.swath.tasks
            .rpc({
              op: "createTask",
              projectId: project.id,
              title: title.trim(),
              deviceId,
              baseCommit: branch.trim() || project.defaultBranch,
            })
            .then((reply) => {
              if (!rpcOk(reply)) {
                setError("Unable to create task");
                return;
              }
              return refresh().then(onClose);
            })
            .catch(() => setError("Unable to create task"));
        }}
      >
        <h2 className="mb-3 text-sm font-semibold text-swath-text">Create task</h2>
        <label className="mb-3 block text-xs text-swath-muted">
          Task name
          <input
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 w-full rounded border border-swath-border bg-swath-bg px-2 py-1.5 text-swath-text"
          />
        </label>
        <label className="mb-3 block text-xs text-swath-muted">
          Branch / fork
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="mt-1 w-full rounded border border-swath-border bg-swath-bg px-2 py-1.5 text-swath-text"
          />
        </label>
        <label className="mb-3 block text-xs text-swath-muted">
          Device
          <select
            required
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className="mt-1 w-full rounded border border-swath-border bg-swath-bg px-2 py-1.5 text-swath-text"
          >
            <option value="">Choose device</option>
            {deviceId && !online.has(deviceId) ? (
              <option value={deviceId} disabled>
                Previously used device (unavailable)
              </option>
            ) : null}
            {devices.map((device) => (
              <option key={device.id} value={device.id} disabled={!online.has(device.id)}>
                {device.displayName}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="mb-2 text-xs text-swath-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm text-swath-muted hover:bg-swath-bg"
          >
            Cancel
          </button>
          <button className="rounded bg-swath-accent px-2 py-1 text-sm text-white">Create</button>
        </div>
      </form>
    </div>
  );
}

function TransferDialog({
  taskId,
  currentDevice,
  devices,
  onClose,
  onDone,
}: {
  taskId: string;
  currentDevice: string;
  devices: { id: string; displayName: string }[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [destinationDeviceId, setDestination] = useState("");
  const [message, setMessage] = useState("");
  const [agentsStopped, setAgentsStopped] = useState(false);
  const [serverConfirmed, setServerConfirmed] = useState(false);
  const [secretApproval, setSecretApproval] = useState(false);
  const transfer = async () => {
    if (!agentsStopped || !serverConfirmed) return;
    const p: any = await window.swath.tasks.rpc({
      op: "transferPreflight",
      taskId,
      destinationDeviceId,
      ...(secretApproval ? { secretApproval: true } : {}),
    });
    if (!p?.ok) return setMessage(p?.error ?? "Preflight failed");
    const r: any = await window.swath.tasks.rpc({
      op: "transferConfirm",
      operationId: p.operationId,
      agentsStopped: true,
      serverConfirmed: true,
    });
    setMessage(r?.ok ? "Transfer complete" : (r?.error ?? "Transfer failed"));
    if (r?.ok) onDone();
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Transfer task"
      className="fixed inset-0 z-[120] grid place-items-center bg-black/50"
    >
      <div className="w-[380px] rounded-lg border border-swath-border bg-swath-panel p-4">
        <h2 className="font-semibold text-swath-text">Transfer task</h2>
        <p className="mt-2 text-xs text-swath-muted">
          All agents must be stopped. Destination preflight runs before the source is frozen.
        </p>
        <select
          className="mt-3 w-full rounded border border-swath-border bg-swath-bg p-2"
          value={destinationDeviceId}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="">Choose destination</option>
          {devices
            .filter((d) => d.id !== currentDevice)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.displayName}
              </option>
            ))}
        </select>
        <label className="mt-3 flex gap-2 text-xs text-swath-muted">
          <input
            type="checkbox"
            checked={agentsStopped}
            onChange={(e) => setAgentsStopped(e.target.checked)}
          />{" "}
          Agents and task shells are stopped
        </label>
        <label className="mt-2 flex gap-2 text-xs text-swath-muted">
          <input
            type="checkbox"
            checked={serverConfirmed}
            onChange={(e) => setServerConfirmed(e.target.checked)}
          />{" "}
          I confirm servers may be stopped
        </label>
        <label className="mt-2 flex gap-2 text-xs text-swath-muted">
          <input
            type="checkbox"
            checked={secretApproval}
            onChange={(e) => setSecretApproval(e.target.checked)}
          />{" "}
          I explicitly approve transfer of secret-like files
        </label>
        <p className="mt-2 text-xs text-swath-muted">{message}</p>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose}>Cancel</button>
          <button
            disabled={!destinationDeviceId || !agentsStopped || !serverConfirmed}
            className="rounded bg-swath-accent px-2 py-1 text-white"
            onClick={() => void transfer()}
          >
            Stop agents & transfer
          </button>
        </div>
      </div>
    </div>
  );
}
function CleanupDialog({
  taskId,
  preview,
  previewToken,
  onClose,
  onDone,
}: {
  taskId: string;
  preview: unknown;
  previewToken: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [message, setMessage] = useState("");
  const token = previewToken;
  const confirm = async () => {
    const r: any = await window.swath.tasks.rpc({
      op: "cleanupConfirm",
      taskId,
      previewToken: token,
      agentsStopped: true,
      serverConfirmed: true,
    });
    setMessage(r?.ok ? "Cleanup complete" : (r?.error ?? "Cleanup failed"));
    if (r?.ok) onDone();
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cleanup preview"
      className="fixed inset-0 z-[120] grid place-items-center bg-black/50"
    >
      <div className="w-[500px] rounded-lg border border-swath-border bg-swath-panel p-4">
        <h2 className="font-semibold text-swath-text">Cleanup preview</h2>
        <pre className="mt-2 max-h-64 overflow-auto text-xs text-swath-muted">
          {JSON.stringify(preview, null, 2)}
        </pre>
        <p className="text-xs text-swath-danger">
          This preview is invalidated by any ref or worktree change. Agents must be stopped.
        </p>
        <p className="text-xs text-swath-muted">{message}</p>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose}>Cancel</button>
          <button
            className="rounded bg-swath-danger px-2 py-1 text-white"
            onClick={() => void confirm()}
          >
            Stop agents & remove managed worktree
          </button>
        </div>
      </div>
    </div>
  );
}

export function TaskWorkspace(): JSX.Element {
  const { catalog, local, devices, networkId, refresh, selectTask } = useTaskStore();
  const settings = useConfigStore((state) => state.config?.settings);
  const [createOpen, setCreateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [cleanup, setCleanup] = useState<{ token: string; preview: unknown } | null>(null);
  const [taskPaths, setTaskPaths] = useState<Record<string, string>>({});
  const projectTasks = catalog.tasks.filter((task) => task.projectId === local.activeProjectId);
  const task =
    catalog.tasks.find((item) => item.id === (local.historicalTaskId ?? local.activeTaskId)) ??
    null;
  const panes = useMemo(() => {
    if (!task) return [];
    const localOrder = local.paneOrderByTask[task.id] ?? [];
    const ids = [...localOrder, ...task.paneOrder.filter((id) => !localOrder.includes(id))];
    return (
      ids
        .map((id) => catalog.panes.find((pane) => pane.id === id))
        .filter((pane): pane is NonNullable<typeof pane> => Boolean(pane))
        // Historical inspection is transcript-only: never mount an executor-backed pane.
        .filter((pane) =>
          local.historicalTaskId || task.lifecycle === "completed" ? pane.kind === "piAgent" : true,
        )
    );
  }, [catalog.panes, local.historicalTaskId, local.paneOrderByTask, task]);
  const cwd = task ? taskPaths[task.id] : undefined;
  useEffect(() => {
    if (!task || local.historicalTaskId) return;
    let active = true;
    void window.swath.tasks.rpc({ op: "getTask", taskId: task.id }).then((reply: any) => {
      const path = typeof reply?.worktreePath === "string" ? reply.worktreePath.trim() : "";
      if (active && path) setTaskPaths((paths) => ({ ...paths, [task.id]: path }));
    });
    return () => {
      active = false;
    };
  }, [task, local.historicalTaskId]);
  const projection = useMemo(
    () => (task ? taskRendererProjection(task, panes, cwd ?? "", local.focusedPaneId) : null),
    [task, panes, cwd, local.focusedPaneId],
  );
  // Keep this object stable: Pi history hydration is keyed by this context.
  const taskExecution = useMemo(
    () =>
      task && projection
        ? {
            networkId: networkId ?? undefined,
            taskId: task.id,
            executionGeneration: task.executionGeneration,
            readOnly: Boolean(local.historicalTaskId) || task.lifecycle === "completed",
            cwd: projection.workspace.path,
          }
        : undefined,
    [local.historicalTaskId, networkId, projection, task],
  );
  const mutate = (request: Parameters<typeof window.swath.tasks.rpc>[0]) =>
    void window.swath.tasks.rpc(request).then(refresh);
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_1fr] bg-swath-bg">
      <TaskTabBar
        tasks={projectTasks}
        activeTaskId={local.activeTaskId}
        onSelect={(id) => selectTask(id)}
        onCreate={() => setCreateOpen(true)}
        onHistory={() => setHistoryOpen(true)}
      />
      <main className="min-h-0 p-2">
        {task ? (
          <div className="h-full rounded border border-swath-border bg-swath-panel p-3">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="font-semibold text-swath-text">{task.title}</h2>
              {local.historicalTaskId ? (
                <span className="text-xs text-swath-muted">Historical task — read only</span>
              ) : null}
              <select
                aria-label="Task device"
                value={task.assignedDeviceId}
                disabled
                className="rounded border border-swath-border bg-swath-bg px-2 py-1 text-xs text-swath-muted"
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.displayName}
                  </option>
                ))}
              </select>
              <button
                disabled={Boolean(local.historicalTaskId)}
                className="ml-auto rounded px-2 py-1 text-xs text-swath-muted hover:bg-swath-bg"
                onClick={() => setTransferOpen(true)}
              >
                Transfer
              </button>
              <button
                disabled={Boolean(local.historicalTaskId)}
                className="rounded px-2 py-1 text-xs text-swath-danger hover:bg-swath-bg"
                onClick={() =>
                  void window.swath.tasks
                    .rpc({ op: "cleanupPreview", taskId: task.id })
                    .then(
                      (r: any) =>
                        r?.ok && setCleanup({ token: r.previewToken, preview: r.preview }),
                    )
                }
              >
                Cleanup
              </button>
              <button
                disabled={Boolean(local.historicalTaskId)}
                className="rounded px-2 py-1 text-xs text-swath-good hover:bg-swath-bg"
                onClick={() => mutate({ op: "completeTask", taskId: task.id })}
              >
                Complete
              </button>
            </div>
            <div className="h-[calc(100%-2.5rem)] min-h-0">
              {projection && settings ? (
                <LayoutRenderer
                  workspace={projection.workspace}
                  view={projection.view}
                  settings={settings}
                  node={projection.view.layout}
                  taskExecution={taskExecution}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-swath-muted">
                  Preparing task worktree…
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-swath-muted">
            Create or select a task.
          </div>
        )}
      </main>
      {transferOpen && task ? (
        <TransferDialog
          taskId={task.id}
          currentDevice={task.assignedDeviceId}
          devices={devices}
          onClose={() => setTransferOpen(false)}
          onDone={() => void refresh()}
        />
      ) : null}
      {cleanup && task ? (
        <CleanupDialog
          taskId={task.id}
          preview={cleanup.preview}
          previewToken={cleanup.token}
          onClose={() => setCleanup(null)}
          onDone={() => void refresh()}
        />
      ) : null}
      {createOpen ? <CreateTaskDialog onClose={() => setCreateOpen(false)} /> : null}
      {historyOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Task history"
          className="fixed inset-0 z-[120] grid place-items-center bg-black/50"
        >
          <div className="w-[420px] rounded-lg border border-swath-border bg-swath-panel p-4">
            <div className="mb-2 flex justify-between">
              <h2 className="font-semibold text-swath-text">Task history</h2>
              <button onClick={() => setHistoryOpen(false)}>×</button>
            </div>
            {projectTasks
              .filter((t) => t.lifecycle === "completed")
              .map((item) => (
                <button
                  key={item.id}
                  className="block w-full rounded px-2 py-2 text-left text-swath-muted hover:bg-swath-bg"
                  onClick={() => {
                    selectTask(item.id, true);
                    setHistoryOpen(false);
                  }}
                >
                  {item.title}
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
