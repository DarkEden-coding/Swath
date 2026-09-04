import { useLayoutEffect, useRef, useState } from "react";
import type { PiToolEntry } from "./eventReducer";
import {
  EDGE_PAD,
  insetEnds,
  roundedPath,
  ROUTE_CLEARANCE,
  routeOrthogonal,
  type NodeBox,
  type Point,
} from "./todoWebRoute";

type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  notes: string[];
  dependencies: string[];
  status: TodoStatus;
}

type Kind = "done" | "run" | "ready" | "blocked";

interface Routed {
  d: string;
  start: Point;
  end: Point;
  fromColor: string;
  toColor: string;
  dashed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function list(record: Record<string, unknown> | undefined, ...keys: string[]): unknown[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function parseTask(value: unknown): TodoTask | null {
  if (!isRecord(value)) return null;
  const id = str(value, "id") ?? "";
  const title = str(value, "title", "name") ?? "";
  if (!id && !title) return null;
  const raw = str(value, "status") ?? "pending";
  const status: TodoStatus = raw === "completed" || raw === "in_progress" ? raw : "pending";
  return {
    id: id || title,
    title: title || id,
    description: str(value, "description") ?? "",
    acceptanceCriteria: list(value, "acceptanceCriteria").filter(
      (item): item is string => typeof item === "string",
    ),
    notes: list(value, "notes").filter((item): item is string => typeof item === "string"),
    dependencies: list(value, "dependencies").filter(
      (item): item is string => typeof item === "string",
    ),
    status,
  };
}

function readWeb(
  args: Record<string, unknown>,
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (isRecord(details?.web)) return details.web;
  if (isRecord(args.web)) return args.web;
  return undefined;
}

function completedIds(
  args: Record<string, unknown>,
  details: Record<string, unknown> | undefined,
): string[] {
  const fromDetails = list(details, "lastCompletedTaskIds").filter(
    (value): value is string => typeof value === "string",
  );
  if (fromDetails.length) return fromDetails;
  const single = str(details, "lastCompletedTaskId") ?? str(args, "taskId");
  if (single) return [single];
  return list(args, "completions")
    .filter(isRecord)
    .map((item) => str(item, "id"))
    .filter((id): id is string => Boolean(id));
}

function isReady(task: TodoTask, byId: Map<string, TodoTask>): boolean {
  if (task.status === "completed") return false;
  return task.dependencies.every((id) => byId.get(id)?.status === "completed");
}

function kindOf(task: TodoTask, ready: boolean): Kind {
  if (task.status === "completed") return "done";
  if (task.status === "in_progress") return "run";
  if (ready) return "ready";
  return "blocked";
}

function markOf(kind: Kind): string {
  if (kind === "done") return "✓";
  if (kind === "run") return "●";
  if (kind === "ready") return "○";
  return "⊘";
}

function depthOf(
  task: TodoTask,
  byId: Map<string, TodoTask>,
  memo: Map<string, number>,
  stack: Set<string>,
): number {
  const cached = memo.get(task.id);
  if (cached !== undefined) return cached;
  if (stack.has(task.id) || !task.dependencies.length) {
    memo.set(task.id, 0);
    return 0;
  }
  stack.add(task.id);
  let depth = 0;
  for (const id of task.dependencies) {
    const dep = byId.get(id);
    if (dep) depth = Math.max(depth, 1 + depthOf(dep, byId, memo, stack));
  }
  stack.delete(task.id);
  memo.set(task.id, depth);
  return depth;
}

function layersOf(tasks: TodoTask[]): TodoTask[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const stack = new Set<string>();
  const layers: TodoTask[][] = [];
  for (const task of tasks) {
    const depth = depthOf(task, byId, memo, stack);
    (layers[depth] ??= []).push(task);
  }
  return layers;
}

function successorAdj(tasks: Array<{ id: string; dependencies: string[] }>): Map<string, string[]> {
  const known = new Set(tasks.map((task) => task.id));
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    if (!adj.has(task.id)) adj.set(task.id, []);
    for (const dep of task.dependencies) {
      if (!known.has(dep)) continue;
      const next = adj.get(dep);
      if (next) next.push(task.id);
      else adj.set(dep, [task.id]);
    }
  }
  return adj;
}

function reachesViaOtherPath(from: string, to: string, adj: Map<string, string[]>): boolean {
  const stack: string[] = [];
  const seen = new Set<string>([from]);
  for (const next of adj.get(from) ?? []) {
    if (next === to) continue;
    seen.add(next);
    stack.push(next);
  }
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of adj.get(current) ?? []) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/** Declared deps that are not implied by a longer path (transitive reduction). */
export function coveringDependencies(
  tasks: Array<{ id: string; dependencies: string[] }>,
): Map<string, string[]> {
  const known = new Set(tasks.map((task) => task.id));
  const adj = successorAdj(tasks);
  const covering = new Map<string, string[]>();
  for (const task of tasks) {
    covering.set(
      task.id,
      task.dependencies.filter((dep) => !known.has(dep) || !reachesViaOtherPath(dep, task.id, adj)),
    );
  }
  return covering;
}

function stroke(kind: Kind): string {
  if (kind === "done") return "var(--pi-green)";
  if (kind === "run") return "var(--pi-cyan)";
  if (kind === "ready") return "var(--pi-yellow)";
  return "var(--pi-border)";
}

function taskLabel(task: TodoTask | undefined, id: string): string {
  return task ? `${task.id}: ${task.title}` : id;
}

function routeGraph(
  root: HTMLElement,
  tasks: TodoTask[],
  byId: Map<string, TodoTask>,
  waitsOn: Map<string, string[]>,
): Routed[] {
  const size = root.getBoundingClientRect();
  const nodeEls = [...root.querySelectorAll<HTMLElement>("[data-todo-id]")];
  const boxes = new Map<string, NodeBox>();
  for (const el of nodeEls) {
    const id = el.dataset.todoId;
    if (!id) continue;
    const box = el.getBoundingClientRect();
    boxes.set(id, {
      id,
      x: box.left - size.left,
      y: box.top - size.top,
      w: box.width,
      h: box.height,
    });
  }

  const depth = new Map<string, number>();
  layersOf(tasks).forEach((layer, index) => layer.forEach((task) => depth.set(task.id, index)));

  interface Edge {
    dep: string;
    task: TodoTask;
    from: NodeBox;
    to: NodeBox;
    adjacent: boolean;
  }
  const edges: Edge[] = [];
  for (const task of tasks) {
    for (const dep of waitsOn.get(task.id) ?? []) {
      const from = boxes.get(dep);
      const to = boxes.get(task.id);
      if (!from || !to || !byId.has(dep)) continue;
      const adjacent = (depth.get(task.id) ?? 0) - (depth.get(dep) ?? 0) === 1;
      edges.push({ dep, task, from, to, adjacent });
    }
  }

  // Edges between neighbouring columns share one vertical lane per source inside the gutter, so
  // fan-outs branch from a single trunk and fan-ins merge into one, instead of parallel zig-zags.
  const laneX = new Map<string, number>();
  const gutters = new Map<number, Edge[]>();
  for (const edge of edges) {
    if (!edge.adjacent) continue;
    const gutter = depth.get(edge.dep) ?? 0;
    (gutters.get(gutter) ?? gutters.set(gutter, []).get(gutter)!).push(edge);
  }
  for (const gutterEdges of gutters.values()) {
    const left = Math.max(...gutterEdges.map((edge) => edge.from.x + edge.from.w)) + EDGE_PAD;
    const right = Math.min(...gutterEdges.map((edge) => edge.to.x)) - EDGE_PAD;
    const span = new Map<string, { min: number; max: number }>();
    for (const edge of gutterEdges) {
      const ys = [edge.from.y + edge.from.h / 2, edge.to.y + edge.to.h / 2];
      const current = span.get(edge.dep) ?? { min: Infinity, max: -Infinity };
      current.min = Math.min(current.min, ...ys);
      current.max = Math.max(current.max, ...ys);
      span.set(edge.dep, current);
    }
    // Narrow fan-outs take the lanes nearest their source so wide trunks do not cut their stubs.
    const sources = [...span.entries()]
      .sort(([, a], [, b]) => a.max - a.min - (b.max - b.min) || a.min - b.min)
      .map(([id]) => id);
    sources.forEach((id, index) => {
      laneX.set(id, left + ((right - left) * (index + 1)) / (sources.length + 1));
    });
  }

  const routed: Routed[] = [];
  const occupied: Point[][] = [];
  const bounds = { w: size.width, h: size.height };
  const route = (edge: Edge): Point[] => {
    const { dep, task, from, to } = edge;
    const start: Point = { x: from.x + from.w, y: from.y + from.h / 2 };
    const end: Point = { x: to.x, y: to.y + to.h / 2 };
    const lane = laneX.get(dep);
    if (edge.adjacent && lane !== undefined) {
      if (Math.abs(start.y - end.y) < 0.5) return [start, end];
      return [start, { x: lane, y: start.y }, { x: lane, y: end.y }, end];
    }
    const routeStart: Point = { x: start.x + ROUTE_CLEARANCE, y: start.y };
    const routeEnd: Point = { x: end.x - ROUTE_CLEARANCE, y: end.y };
    const obstacles = [...boxes.values()].filter((box) => box.id !== dep && box.id !== task.id);
    return [start, ...routeOrthogonal(routeStart, routeEnd, obstacles, bounds, occupied), end];
  };
  // Lane routes first so longer, obstacle-avoiding edges steer clear of them.
  const ordered = [
    ...edges.filter((edge) => edge.adjacent),
    ...edges.filter((edge) => !edge.adjacent),
  ];
  for (const edge of ordered) {
    const fromTask = byId.get(edge.dep)!;
    const points = insetEnds(route(edge), EDGE_PAD, EDGE_PAD);
    occupied.push(points);
    const fromKind = kindOf(fromTask, isReady(fromTask, byId));
    const toKind = kindOf(edge.task, isReady(edge.task, byId));
    routed.push({
      d: roundedPath(points),
      start: points[0],
      end: points[points.length - 1],
      fromColor: stroke(fromKind),
      toColor: stroke(toKind),
      dashed: toKind === "blocked",
    });
  }
  return routed;
}

export function TodoWebPreview({
  args,
  entry,
  streaming,
}: {
  args: Record<string, unknown>;
  entry: PiToolEntry;
  streaming: boolean;
}): JSX.Element | null {
  const details = isRecord(entry.details) ? entry.details : undefined;
  const web = readWeb(args, details);
  const tasks = web
    ? list(web, "tasks")
        .map(parseTask)
        .filter((task): task is TodoTask => task !== null)
    : [];
  const action = str(args, "action");
  const rootRef = useRef<HTMLDivElement>(null);
  const [routes, setRoutes] = useState<Routed[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const layers = layersOf(tasks);
  const waitsOn = coveringDependencies(tasks);
  const justDone = new Set(completedIds(args, details));

  const graphKey = tasks
    .map((task) => `${task.id}:${task.status}:${task.dependencies.join(",")}`)
    .join("|");
  const tasksRef = useRef(tasks);

  useLayoutEffect(() => {
    tasksRef.current = tasks;
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const current = tasksRef.current;
    if (!root || !current.length) {
      setRoutes([]);
      return;
    }
    const ids = new Map(current.map((task) => [task.id, task]));
    const waitsOn = coveringDependencies(current);
    const draw = () => {
      setSize({ w: root.clientWidth, h: root.clientHeight });
      setRoutes(routeGraph(root, current, ids, waitsOn));
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [graphKey]);

  if (!tasks.length) {
    if (streaming && (action === "set" || web)) {
      return (
        <div className="pi-todo">
          <span className="pi-dim">building web…</span>
          <span className="pi-streaming-cursor">▍</span>
        </div>
      );
    }
    return null;
  }

  const done = tasks.filter((task) => task.status === "completed").length;
  const readyTasks = tasks.filter((task) => isReady(task, byId));
  const blocked = tasks.filter((task) => task.status !== "completed" && !isReady(task, byId));
  const title = str(web, "title") ?? "Todo Web";
  const lastIndex = tasks.length - 1;

  return (
    <div className="pi-todo">
      <div className="pi-todo-head">
        <span className="pi-todo-title">{title}</span>
        <span className="pi-dim">
          {done}/{tasks.length} completed · {readyTasks.length} ready · {blocked.length} blocked
        </span>
      </div>
      <div className="pi-todo-meter" aria-hidden="true">
        <span style={{ width: `${Math.round((done / tasks.length) * 100)}%` }} />
      </div>
      {justDone.size ? (
        <div className="pi-todo-flash">
          completed {[...justDone].map((id) => taskLabel(byId.get(id), id)).join(", ")}
        </div>
      ) : null}
      <div className="pi-todo-dag" ref={rootRef}>
        <svg className="pi-todo-edges" viewBox={`0 0 ${size.w} ${size.h}`} aria-hidden="true">
          <defs>
            {routes.map((route, index) => (
              <g key={index}>
                <linearGradient
                  id={`pi-todo-line-${entry.id}-${index}`}
                  gradientUnits="userSpaceOnUse"
                  x1={route.start.x}
                  y1={route.start.y}
                  x2={route.end.x}
                  y2={route.end.y}
                >
                  <stop offset="0" stopColor={route.fromColor} />
                  <stop offset="1" stopColor={route.toColor} />
                </linearGradient>
                <marker
                  id={`pi-todo-arrow-${entry.id}-${index}`}
                  viewBox="0 0 8 8"
                  refX="8"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M 0 1 L 8 4 L 0 7 z" fill={route.toColor} />
                </marker>
              </g>
            ))}
          </defs>
          {routes.map((route, index) => (
            <path
              key={index}
              d={route.d}
              fill="none"
              stroke={`url(#pi-todo-line-${entry.id}-${index})`}
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={route.dashed ? "4 3" : undefined}
              markerEnd={`url(#pi-todo-arrow-${entry.id}-${index})`}
            />
          ))}
        </svg>
        <div
          className="pi-todo-cols"
          style={{ gridTemplateColumns: `repeat(${Math.max(layers.length, 1)}, minmax(0, 1fr))` }}
        >
          {layers.map((layer, index) => (
            <div key={index} className="pi-todo-col">
              <div className="pi-todo-col-label">Depth {index}</div>
              {layer.map((task) => {
                const kind = kindOf(task, isReady(task, byId));
                const deps = waitsOn.get(task.id) ?? [];
                const unlocks = tasks.filter((candidate) =>
                  (waitsOn.get(candidate.id) ?? []).includes(task.id),
                );
                const depText = deps.length
                  ? deps
                      .map((id) => `${id}${byId.get(id)?.status === "completed" ? " ✓" : ""}`)
                      .join(", ")
                  : "none";
                const unlockText = unlocks.length
                  ? unlocks.map((item) => item.id).join(", ")
                  : "none";
                const live = streaming && tasks.indexOf(task) === lastIndex;
                return (
                  <div
                    key={task.id}
                    data-todo-id={task.id}
                    className={`pi-todo-node is-${kind}${justDone.has(task.id) ? " is-just" : ""}`}
                  >
                    <span className="pi-todo-port in" />
                    <span className="pi-todo-port out" />
                    <span className={`pi-todo-mark is-${kind}`}>{markOf(kind)}</span>{" "}
                    <span className="pi-todo-id">{task.id}</span>
                    <span className="pi-todo-node-title">
                      {task.title}
                      {live ? <span className="pi-streaming-cursor">▍</span> : null}
                    </span>
                    <div className="pi-todo-node-deps">
                      {kind === "done" ? `unlocks ${unlockText}` : `waits on ${depText}`}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function todoWebLabel(args: Record<string, unknown>, entry: PiToolEntry): string {
  const action = str(args, "action") ?? "";
  const details = isRecord(entry.details) ? entry.details : undefined;
  const web = readWeb(args, details);
  const tasks = web ? list(web, "tasks") : [];
  const done = tasks.filter((task) => isRecord(task) && task.status === "completed").length;
  const count = tasks.length ? ` · ${done}/${tasks.length}` : "";
  const title = web ? str(web, "title") : undefined;
  const completed = completedIds(args, details);
  const suffix = title
    ? ` · ${title.replace(/\s+/g, " ").trim().slice(0, 40)}`
    : completed.length
      ? ` · ${completed.join(", ")}`
      : "";
  return `☑ Todo ${action}${count}${suffix}`.trimEnd();
}
