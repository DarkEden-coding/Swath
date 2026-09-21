import { useEffect, useMemo, useState } from "react";
import type { LayoutNode, PaneKind, Workspace, WorkspaceView } from "../../../shared/types";
import { useTaskStore } from "../../state/taskStore";
import { useConfigStore } from "../../state/configStore";
import { LayoutRenderer } from "../panes/components/LayoutRenderer";
import { TaskTabBar } from "../views/components/ViewTabBar";
import { collectPanes } from "../../domain/layout/layoutTree";
import { setViewedPanes } from "../tabTypes/piAgent/piActivity";
import { reorderTaskPanes } from "../../domain/tasks/catalogMutations";
import { reportError } from "../../lib/errorLog";

/** Legacy imports sometimes stored the old pane id here; Pi's --session accepts a JSONL path/id. */
export function piSessionMetadata(
  sessionId: string | null | undefined,
): { metadata: { piSessionFile: string } } | Record<string, never> {
  const value = sessionId?.trim();
  return value && !value.startsWith("pane_") ? { metadata: { piSessionFile: value } } : {};
}

/** Minimal legacy shape required by registered pane renderers; task ownership stays separate. */
export function taskRendererProjection(
  task: { id: string; title: string },
  panes: { id: string; kind: string; title: string | null; sessionId?: string | null }[],
  cwd: string,
  focusedPaneId?: string | null,
  legacyWorkspace?: Workspace | null,
  activeViewId?: string | null,
): { workspace: Workspace; view: WorkspaceView } {
  if (legacyWorkspace?.views.length) {
    const paneByLegacyId = new Map(
      panes.flatMap((pane) => [
        [pane.id, pane] as const,
        [pane.id.split(":").at(-1) ?? pane.id, pane] as const,
      ]),
    );
    const remap = (node: LayoutNode): LayoutNode | null => {
      if (node.type === "pane") {
        const pane = paneByLegacyId.get(node.id);
        if (!pane) return null;
        return {
          ...node,
          id: pane.id,
          kind: pane.kind as PaneKind,
          title: pane.title ?? undefined,
          cwd,
          ...piSessionMetadata(pane.sessionId),
        };
      }
      const first = remap(node.first);
      const second = remap(node.second);
      if (!first) return second;
      if (!second) return first;
      return { ...node, first, second };
    };
    const restored = legacyWorkspace.views.flatMap((view) => {
      const layout = remap(view.layout);
      if (!layout) return [];
      const liveIds = collectPanes(layout).map((pane) => pane.id);
      return [
        {
          ...view,
          layout,
          activePaneId: liveIds.includes(view.activePaneId) ? view.activePaneId : liveIds[0],
        },
      ];
    });
    const restoredPaneIds = new Set(
      restored.flatMap((view) => collectPanes(view.layout).map((p) => p.id)),
    );
    const added = panes
      .filter((pane) => !restoredPaneIds.has(pane.id))
      .map((pane, index): WorkspaceView => ({
        id: `task-view:${pane.id}`,
        type: "workspace-view",
        title:
          pane.title ??
          `${pane.kind === "piAgent" ? "Pi Agent" : pane.kind === "gitManager" ? "Source Control" : pane.kind === "fileBrowser" ? "Files" : "Terminal"} ${restored.length + index + 1}`,
        layout: {
          type: "pane",
          id: pane.id,
          kind: pane.kind as PaneKind,
          title: pane.title ?? undefined,
          cwd,
          ...piSessionMetadata(pane.sessionId),
        },
        activePaneId: pane.id,
      }));
    const panePositions = new Map(panes.map((pane, index) => [pane.id, index]));
    // Migrated workspaces retain their split geometry and titles, but their old view array is not
    // the tab-order authority. Sort whole views by the first pane they contain in the catalog.
    const views = [...restored, ...added].sort((left, right) => {
      const position = (view: WorkspaceView) =>
        Math.min(
          ...collectPanes(view.layout).map(
            (pane) => panePositions.get(pane.id) ?? Number.MAX_SAFE_INTEGER,
          ),
        );
      return position(left) - position(right);
    });
    if (!views.length) {
      const empty = {
        type: "pane" as const,
        id: `${task.id}:empty`,
        kind: "terminal" as const,
        cwd,
      };
      views.push({
        id: `task-view:${empty.id}`,
        type: "workspace-view",
        title: "Terminal 1",
        layout: empty,
        activePaneId: empty.id,
      });
    }
    const view = views.find((item) => item.id === activeViewId) ?? views[0]!;
    return {
      workspace: {
        ...legacyWorkspace,
        id: `task:${task.id}`,
        name: task.title,
        path: cwd,
        views,
        activeViewId: view.id,
      },
      view,
    };
  }
  const leaves = panes.map((pane) => ({
    type: "pane" as const,
    id: pane.id,
    kind: pane.kind as PaneKind,
    title: pane.title ?? undefined,
    cwd,
    ...piSessionMetadata(pane.sessionId),
  }));
  const views: WorkspaceView[] = leaves.map((pane, index) => ({
    id: `task-view:${pane.id}`,
    type: "workspace-view",
    title:
      panes[index]?.title ??
      `${pane.kind === "piAgent" ? "Pi Agent" : pane.kind === "gitManager" ? "Source Control" : pane.kind === "fileBrowser" ? "Files" : "Terminal"} ${index + 1}`,
    layout: pane,
    activePaneId: pane.id,
  }));
  if (!views.length) {
    const empty = { type: "pane" as const, id: `${task.id}:empty`, kind: "terminal" as const, cwd };
    views.push({
      id: `task-view:${empty.id}`,
      type: "workspace-view",
      title: "Terminal 1",
      layout: empty,
      activePaneId: empty.id,
    });
  }
  const view =
    views.find((item) => item.id === activeViewId || item.activePaneId === focusedPaneId) ??
    views[0]!;
  return {
    workspace: {
      id: `task:${task.id}`,
      name: task.title,
      path: cwd,
      views,
      activeViewId: view.id,
      createdAt: 0,
      updatedAt: 0,
    },
    view,
  };
}

/** Returns the durable pane order produced by a task-tab drag. */
export function reorderedPaneIds(
  paneIds: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const order = [...paneIds];
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= order.length ||
    toIndex >= order.length ||
    fromIndex === toIndex
  )
    return order;
  const [paneId] = order.splice(fromIndex, 1);
  if (paneId) order.splice(toIndex, 0, paneId);
  return order;
}

/** Moves whole tabs, keeping every pane in a legacy split view together. */
export function reorderedTaskViewPaneIds(
  views: readonly WorkspaceView[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const moved = reorderedPaneIds(
    views.map((view) => view.id),
    fromIndex,
    toIndex,
  );
  return moved.flatMap((id) =>
    collectPanes(views.find((view) => view.id === id)!.layout).map((pane) => pane.id),
  );
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
                const detail =
                  reply && typeof reply === "object" && "message" in reply
                    ? String((reply as { message?: unknown }).message ?? "")
                    : "";
                setError(detail || "Unable to create task");
                return;
              }
              return refresh().then(onClose);
            })
            .catch((reason) =>
              setError(reason instanceof Error ? reason.message : "Unable to create task"),
            );
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
  const [activeViewIds, setActiveViewIds] = useState<Record<string, string>>({});
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
  const legacyWorkspace = useMemo(
    () =>
      task
        ? (useConfigStore
            .getState()
            .config?.workspaces.find((workspace) => task.id.includes(workspace.id)) ?? null)
        : null,
    [task],
  );
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
    () =>
      task
        ? taskRendererProjection(
            task,
            panes,
            cwd ?? "",
            local.focusedPaneId,
            legacyWorkspace,
            activeViewIds[task.id],
          )
        : null,
    [task, panes, cwd, local.focusedPaneId, legacyWorkspace, activeViewIds],
  );
  useEffect(() => {
    setViewedPanes(
      projection
        ? collectPanes(projection.view.layout)
            .filter((pane) => pane.kind === "piAgent")
            .map((pane) => pane.id)
        : [],
    );
  }, [projection]);
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
  const mutate = (request: Parameters<typeof window.swath.tasks.rpc>[0]) => {
    void window.swath.tasks
      .rpc(request)
      .then((reply) => {
        if (!rpcOk(reply)) throw new Error(JSON.stringify(reply));
      })
      .catch((error: unknown) => reportError(`Task ${request.op}`, error))
      .finally(
        () => void refresh().catch((error: unknown) => reportError("Refreshing tasks", error)),
      );
  };
  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr] bg-swath-bg">
      <TaskTabBar
        tasks={projectTasks.map((item) => ({
          ...item,
          panes: catalog.panes.filter((pane) => pane.taskId === item.id),
        }))}
        activeTaskId={local.activeTaskId}
        views={(projection?.workspace.views ?? []).map((view) => ({
          id: view.id,
          title: view.title,
        }))}
        activeViewId={projection?.view.id ?? null}
        onSelect={(id) => selectTask(id)}
        onSelectView={(id) =>
          task && setActiveViewIds((current) => ({ ...current, [task.id]: id }))
        }
        onReorderView={(fromIndex, toIndex) => {
          if (!task) return;
          if (!projection) return;
          const order = reorderedTaskViewPaneIds(projection.workspace.views, fromIndex, toIndex);
          reorderTaskPanes(task.id, order);
        }}
        onCreatePane={(taskId, kind) =>
          void window.swath.tasks
            .rpc({ op: "createPane", taskId, kind })
            .then(async (reply) => {
              if (!rpcOk(reply)) return;
              await refresh();
              const paneId = (reply as { paneId?: string }).paneId;
              if (paneId)
                setActiveViewIds((current) => ({ ...current, [taskId]: `task-view:${paneId}` }));
            })
            .catch((error: unknown) => reportError("Creating task pane", error))
        }
        piOnly={legacyWorkspace?.isGroupRoot === true}
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
              {task.lifecycle === "completed" ? (
                <button
                  className="rounded px-2 py-1 text-xs text-swath-good hover:bg-swath-bg"
                  onClick={() =>
                    void window.swath.tasks
                      .rpc({ op: "reactivateTask", taskId: task.id })
                      .then(async () => {
                        await refresh();
                        selectTask(task.id);
                      })
                  }
                >
                  Resume
                </button>
              ) : (
                <button
                  className="rounded px-2 py-1 text-xs text-swath-good hover:bg-swath-bg"
                  onClick={() => mutate({ op: "completeTask", taskId: task.id })}
                >
                  Complete
                </button>
              )}
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
