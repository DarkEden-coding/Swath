/**
 * Owns one `pi --mode rpc` child process for a pane: spawns it, feeds stdout lines through the
 * reducer, and exposes a typed `send`.
 *
 * State lives in `useReducer` rather than a store library because nothing outside this pane's
 * subtree reads it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  parsePiLine,
  agentTabRequestFrom,
  type PiAgentTabRequest,
  type PiCommandMessage,
  type PiImageContent,
  type PiThinkingLevel,
  type PiExecutionTarget,
} from "../../../../shared/ipc/piRpc";
import {
  dismissDialog,
  dismissNotice,
  initialPiPaneState,
  reducePiEvent,
  type PiPaneState,
} from "./eventReducer";
import { reportError } from "../../../lib/errorLog";
import { piPaneCache, resumedSessions, spawnedPanes, mountPiPaneEventCache } from "./piPaneCache";
import { reportStreaming } from "./piActivity";
import { loadPiHistoryForPane, syncPiHistory, type PiHistoryStatus } from "./piHistoryCache";

type Action =
  | { type: "line"; line: string }
  | { type: "exit" }
  | { type: "error"; message: string }
  | { type: "dismissDialog"; id: string }
  | { type: "dismissNotice"; id: string }
  | { type: "hydrate"; state: PiPaneState }
  | { type: "reset" };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "object" && error !== null) {
    try {
      const encoded = JSON.stringify(error);
      if (encoded && encoded !== "{}") return encoded;
    } catch {
      // Fall through to the stable generic message below.
    }
  }
  return String(error || "Unknown Pi RPC error");
}

function rpcFailure(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("ok" in result)) return null;
  if ((result as { ok?: unknown }).ok !== false) return null;
  const detail = (result as { error?: unknown }).error;
  return detail === undefined ? "Pi RPC request failed" : errorMessage(detail);
}

function reducer(state: PiPaneState, action: Action): PiPaneState {
  switch (action.type) {
    case "line": {
      const event = parsePiLine(action.line);
      return event ? reducePiEvent(state, event) : state;
    }
    case "exit":
      return { ...state, exited: true, isStreaming: false };
    case "error":
      // A failed startup fans out several handshake writes. Preserve the first error because it
      // contains the child exit/stderr; later requests only say that the process is gone.
      return { ...state, error: state.error ?? action.message };
    case "dismissDialog":
      return dismissDialog(state, action.id);
    case "dismissNotice":
      return dismissNotice(state, action.id);
    case "hydrate":
      // History is an offline fallback. Once the live executor has emitted a transcript (or is
      // actively streaming), a late sync response must never replace it with a stale partition.
      return state.entries.length > 0 || state.isStreaming ? state : action.state;
    case "reset":
      return initialPiPaneState();
    default:
      return state;
  }
}

export interface PiAgentController {
  state: PiPaneState;
  history: { status: PiHistoryStatus; cursor: string | null; conflicts: unknown[] };
  send: (command: PiCommandMessage) => void;
  /** Sends a user prompt, queueing as a follow-up when the agent is mid-run. */
  prompt: (message: string, images?: PiImageContent[]) => void;
  abort: () => void;
  restart: () => void;
  newSession: () => void;
  compact: () => void;
  setModel: (model: string) => void;
  cycleModel: () => void;
  setThinking: (level: PiThinkingLevel) => void;
  cycleThinking: () => void;
  setSessionName: (name: string) => void;
  refreshTree: () => void;
  fork: (entryId: string) => void;
  /** Adopts a previously recorded session file (`/resume`). */
  switchSession: (sessionPath: string) => void;
  answerDialog: (
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: true },
  ) => void;
  dismissNotice: (id: string) => void;
}

/**
 * Builds the flag that tells pi about the other folders in a project group.
 *
 * pi has no multi-root option: it takes one working directory. Its tools are not confined to it,
 * so naming the sibling folders in the system prompt is what makes them usable.
 */
export function groupPathArgs(cwd: string | undefined, paths: readonly string[]): string[] {
  const others = paths.filter((path) => path && path !== cwd);
  if (others.length === 0) return [];
  return [
    "--append-system-prompt",
    [
      "This project spans several directories. The working directory is one of them; the full set is:",
      ...[cwd, ...others]
        .filter((path): path is string => Boolean(path))
        .map((path) => `- ${path}`),
      "Treat them as one codebase: read, search and edit across all of them using absolute paths.",
    ].join("\n"),
  ];
}

/** Starts a fresh independent Pi agent before its tab is first rendered. */
export function prewarmPiAgent(
  paneId: string,
  cwd: string,
  groupPaths: readonly string[],
  start: PiAgentTabRequest,
): void {
  if (spawnedPanes.has(paneId)) return;
  spawnedPanes.add(paneId);
  const args = [
    ...(start.title ? ["--name", start.title] : []),
    ...(start.model ? ["--model", start.model] : []),
    ...(start.reasoningLevel ? ["--thinking", start.reasoningLevel] : []),
    ...groupPathArgs(cwd, groupPaths),
  ];
  void window.swath.pi
    .rpc({ op: "spawn", paneId, cwd, args })
    .then((result) => {
      const failure = rpcFailure(result);
      if (failure) throw new Error(failure);
      return window.swath.pi.rpc({
        op: "send",
        paneId,
        line: JSON.stringify({ type: "prompt", message: start.task }),
      });
    })
    .then((result) => {
      const failure = rpcFailure(result);
      if (failure) throw new Error(failure);
    })
    .catch(() => spawnedPanes.delete(paneId));
}

export function usePiAgent(
  paneId: string,
  cwd: string | undefined,
  /** Every folder of the project group this pane belongs to; empty for a single-folder project. */
  groupPaths: readonly string[] = [],
  initialSessionFile?: string,
  initialStart?: PiAgentTabRequest,
  onAgentTabRequest?: (request: PiAgentTabRequest) => void,
  taskExecution?: Omit<PiExecutionTarget, "paneId"> & { networkId?: string; readOnly?: boolean },
): PiAgentController {
  useEffect(() => mountPiPaneEventCache(paneId), [paneId]);
  const hasTaskExecution = Boolean(taskExecution);
  const taskId = taskExecution?.taskId;
  const networkId = taskExecution?.networkId;
  const executionGeneration = taskExecution?.executionGeneration;
  const readOnly = taskExecution?.readOnly;
  const target = useMemo(
    () => ({
      paneId,
      ...(hasTaskExecution
        ? {
            taskId,
            networkId,
            executionGeneration,
            readOnly,
          }
        : {}),
    }),
    [paneId, hasTaskExecution, taskId, networkId, executionGeneration, readOnly],
  );

  // Read at spawn time only: a group gaining a folder must not restart a running conversation.
  const groupPathsRef = useRef(groupPaths);
  useEffect(() => {
    groupPathsRef.current = groupPaths;
  }, [groupPaths]);

  const [state, dispatch] = useReducer(
    reducer,
    paneId,
    (id) => piPaneCache.get(id)?.state ?? initialPiPaneState(),
  );
  const needsInitialPromptRef = useRef(Boolean(initialStart));
  const [history, setHistory] = useState<{
    status: PiHistoryStatus;
    cursor: string | null;
    conflicts: unknown[];
  }>({
    status: "unavailable",
    cursor: null,
    conflicts: [],
  });
  const [historyReady, setHistoryReady] = useState(!taskExecution?.taskId);

  // Republish every render so a remount (tab switch) restores the transcript synchronously.
  useEffect(() => {
    const entry = piPaneCache.get(paneId);
    piPaneCache.set(paneId, { draft: "", images: [], pastes: [], ...entry, state });
    reportStreaming(paneId, state.isStreaming);
  }, [paneId, state]);

  const send = useCallback(
    (command: PiCommandMessage) => {
      if (readOnly) return;
      const operation =
        command.type === "prompt" || command.type === "follow_up"
          ? { operationId: crypto.randomUUID() }
          : {};
      void window.swath.pi
        .rpc({ op: "send", ...target, ...operation, line: JSON.stringify(command) })
        .then((result) => {
          const failure = rpcFailure(result);
          if (failure) throw new Error(failure);
        })
        .catch((error: unknown) => {
          spawnedPanes.delete(paneId);
          dispatch({ type: "error", message: errorMessage(error) });
        });
    },
    [paneId, readOnly, target],
  );

  /** The startup handshake for a freshly spawned child. */
  const requestFullState = useCallback(() => {
    send({ id: "init-state", type: "get_state" });
    send({ id: "init-commands", type: "get_commands" });
    send({ id: "init-messages", type: "get_messages" });
    send({ id: "init-models", type: "get_available_models" });
    send({ id: "init-thinking", type: "get_available_thinking_levels" });
    send({ id: "init-stats", type: "get_session_stats" });
  }, [send]);

  // Kept in a ref so reattaching can consult the restored transcript without re-running `spawn`
  // (and re-subscribing everything) on every reducer update.
  const hasTranscriptRef = useRef(state.entries.length > 0);
  useEffect(() => {
    hasTranscriptRef.current = state.entries.length > 0;
  }, [state.entries.length]);

  /**
   * Resync for a pane whose child is still running — a tab switch, not a spawn.
   *
   * `piPaneCache` keeps reducing events while the pane is unmounted, so the restored transcript is
   * already current and `get_messages` would only replace it with an identical copy. Skipping it
   * keeps a long conversation off the tab-switch path entirely; only the cheap footer state is
   * refreshed. A pane whose cache was dropped still needs the full handshake.
   */
  const requestResync = useCallback(() => {
    if (!hasTranscriptRef.current) {
      requestFullState();
      return;
    }
    send({ id: "resync-state", type: "get_state" });
    send({ id: "resync-stats", type: "get_session_stats" });
  }, [requestFullState, send]);

  const spawn = useCallback(() => {
    if (taskExecution?.readOnly || !cwd) return;
    // The process outlives an unmount: reattach and pull anything missed while hidden.
    if (spawnedPanes.has(paneId)) {
      requestResync();
      return;
    }
    spawnedPanes.add(paneId);
    // Reopen only the session this pane explicitly reported. An unbound pane is a new
    // conversation; resuming or forking is an explicit UI operation and must never be inferred
    // from another pane sharing the same working directory.
    const sessionFile = resumedSessions.get(paneId) ?? initialSessionFile;
    const isFreshStart = !sessionFile && Boolean(initialStart) && needsInitialPromptRef.current;
    const sessionArgs = sessionFile ? ["--session", sessionFile] : [];
    const startupArgs = initialStart
      ? [
          ...(initialStart.title ? ["--name", initialStart.title] : []),
          ...(initialStart.model ? ["--model", initialStart.model] : []),
          ...(initialStart.reasoningLevel ? ["--thinking", initialStart.reasoningLevel] : []),
        ]
      : [];
    void window.swath.pi
      .rpc({
        op: "spawn",
        ...target,
        cwd,
        args: [...sessionArgs, ...startupArgs, ...groupPathArgs(cwd, groupPathsRef.current)],
      })
      .then((result) => {
        // The host rejects on failure, but a transport that resolves with `{ ok: false }`
        // (the browser fixture) must not leave the pane silently stuck on "Starting pi…".
        const failure = rpcFailure(result);
        if (failure) {
          spawnedPanes.delete(paneId);
          dispatch({ type: "error", message: failure });
          return;
        }
        requestFullState();
        if (isFreshStart && initialStart) {
          needsInitialPromptRef.current = false;
          send({ type: "prompt", message: initialStart.task });
        }
      })
      .catch((error: unknown) => {
        spawnedPanes.delete(paneId);
        dispatch({ type: "error", message: errorMessage(error) });
      });
  }, [
    cwd,
    initialSessionFile,
    initialStart,
    paneId,
    requestFullState,
    requestResync,
    send,
    target,
    taskExecution?.readOnly,
  ]);

  /** Explicit user restart: tear the child down first, then spawn a fresh one. */
  const restart = useCallback(() => {
    if (taskExecution?.readOnly) return;
    spawnedPanes.delete(paneId);
    dispatch({ type: "reset" });
    void window.swath.pi.rpc({ op: "kill", ...target }).finally(spawn);
  }, [paneId, spawn, target, taskExecution?.readOnly]);

  // Kept in a ref so the subscription is created once per pane rather than on every render.
  const sendRef = useRef(send);
  const agentTabRequestRef = useRef(onAgentTabRequest);
  useEffect(() => {
    sendRef.current = send;
    agentTabRequestRef.current = onAgentTabRequest;
  });

  useEffect(() => {
    // Everything below runs inside a Tauri listener, outside React's call stack: a throw here is
    // caught by no error boundary, and leaves the app blank with nothing on screen. Route it to
    // the pane's own error state instead.
    const unsubscribe = window.swath.pi.onEvent((eventPaneId, line, exited) => {
      try {
        handleLine(eventPaneId, line, exited);
      } catch (error) {
        reportError("pi event handler", error);
        dispatch({ type: "error", message: errorMessage(error) });
      }
    });

    function handleLine(eventPaneId: string, line?: string, exited?: boolean): void {
      if (eventPaneId !== paneId) return;
      if (exited) {
        spawnedPanes.delete(paneId);
        dispatch({ type: "exit" });
        return;
      }
      if (!line) return;
      dispatch({ type: "line", line });

      const event = parsePiLine(line);
      if (!event) return;
      const agentTabRequest = agentTabRequestFrom(event);
      if (agentTabRequest) agentTabRequestRef.current?.(agentTabRequest);

      // Session replacement rebinds extensions before the response arrives. Do not reset here:
      // that would erase the replacement session's freshly emitted widgets and model list.
      if (
        event.type === "response" &&
        event.success &&
        (event.id === "new-session" ||
          event.id === "fork-session" ||
          event.id === "switch-session") &&
        !(event.data as { cancelled?: boolean } | undefined)?.cancelled
      ) {
        sendRef.current({ id: "messages", type: "get_messages" });
        sendRef.current({ id: "state", type: "get_state" });
        sendRef.current({ id: "commands", type: "get_commands" });
        sendRef.current({ id: "models", type: "get_available_models" });
        sendRef.current({ id: "thinking", type: "get_available_thinking_levels" });
        sendRef.current({ id: "stats", type: "get_session_stats" });
        sendRef.current({ id: "tree", type: "get_tree" });
      }

      // Footer totals (tokens, cost, context %) change as soon as a turn lands, not only
      // when the whole agent loop settles. Assistant `message_end` is when the main model's
      // usage is written; `turn_end` then includes tool results in the context estimate.
      if (
        event.type === "turn_end" ||
        event.type === "compaction_end" ||
        event.type === "agent_settled" ||
        (event.type === "message_end" && event.message.role === "assistant")
      ) {
        sendRef.current({ id: "stats", type: "get_session_stats" });
      }
      if (event.type === "agent_settled") {
        sendRef.current({ id: "state", type: "get_state" });
      }
    }

    return unsubscribe;
  }, [paneId]);

  // Load durable records before touching the executor. This is deliberately a read-only history
  // RPC: completed/offline task inspection must never ensure or spawn Pi.
  useEffect(() => {
    if (!taskExecution?.taskId) return;
    let active = true;
    queueMicrotask(() => {
      if (active) setHistoryReady(false);
    });
    const scope = {
      networkId: taskExecution.networkId ?? "",
      taskId: taskExecution.taskId,
      paneId,
      sessionId: initialSessionFile ?? "default",
      executionGeneration: taskExecution.executionGeneration ?? 0,
    };
    const hydrate = (cached: Awaited<ReturnType<typeof loadPiHistoryForPane>>): void => {
      if (!cached) return;
      let restored = initialPiPaneState();
      for (const record of cached.records) restored = reducePiEvent(restored, record.event);
      dispatch({ type: "hydrate", state: restored });
    };
    void (async () => {
      let cached = null as Awaited<ReturnType<typeof loadPiHistoryForPane>>;
      try {
        // Render the local partition first; the network request only catches it up afterwards.
        if (scope.networkId) cached = await loadPiHistoryForPane(scope);
        if (cached && active) {
          hydrate(cached);
          setHistory({ status: "local", cursor: cached.cursor, conflicts: [] });
        }
        // Replication is independent of Pi process control: completed/offline inspection never
        // routes through `pi.rpc(history)`, which could otherwise ensure a child.
        await syncPiHistory(scope);
        const next = scope.networkId ? await loadPiHistoryForPane(scope) : null;
        if (active) {
          if (next) hydrate(next);
          setHistory({
            status: "synced",
            cursor: next?.cursor ?? cached?.cursor ?? null,
            conflicts: [],
          });
        }
        const conflicts = scope.networkId
          ? await window.swath.sync.conflicts(scope.networkId)
          : { conflicts: [] };
        if (active)
          setHistory({
            status: "synced",
            cursor: next?.cursor ?? cached?.cursor ?? null,
            conflicts: conflicts.conflicts,
          });
      } catch (error) {
        reportError("Syncing Pi history", error);
        if (cached && active) setHistory({ status: "local", cursor: cached.cursor, conflicts: [] });
        else if (active) setHistory({ status: "unavailable", cursor: null, conflicts: [] });
      } finally {
        if (active) setHistoryReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    initialSessionFile,
    paneId,
    taskExecution?.networkId,
    taskExecution?.executionGeneration,
    taskExecution?.taskId,
  ]);

  // No teardown on unmount: the pane is unmounted on every tab switch, and killing pi there is
  // what forced the reload. `piAgentTabType.closePane` disposes the pane for real.
  useEffect(() => {
    // A failed child stays failed across tab remounts. Only an explicit Restart clears it; a tab
    // switch must never turn a rapid process exit into an unbounded restart/replay loop.
    if (historyReady && !taskExecution?.readOnly && !state.exited && !state.error) spawn();
  }, [historyReady, spawn, state.error, state.exited, taskExecution?.readOnly]);

  // A remote executor can answer before its event relay has finished subscribing. Retry the
  // idempotent state request until one response arrives, rather than leaving the pane forever on
  // “Starting pi…”. The first retry is delayed so local startup keeps its single fast handshake.
  useEffect(() => {
    if (
      !historyReady ||
      taskExecution?.readOnly ||
      state.state ||
      state.error ||
      state.exited ||
      !spawnedPanes.has(paneId)
    )
      return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (++attempts > 10) {
        window.clearInterval(timer);
        dispatch({
          type: "error",
          message:
            "Pi started, but its state did not arrive. Check the executor connection, then Restart pi.",
        });
        return;
      }
      send({ id: "startup-state", type: "get_state" });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [historyReady, paneId, send, state.error, state.exited, state.state, taskExecution?.readOnly]);

  return useMemo<PiAgentController>(
    () => ({
      state,
      history,
      send,
      prompt: (message: string, images?: PiImageContent[]) => {
        if (!message.trim() && !images?.length) return;
        // pi rejects a bare prompt mid-run; queue it instead.
        send({
          type: "prompt",
          message,
          ...(images?.length ? { images } : {}),
          ...(state.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
        });
      },
      abort: () => send({ type: "abort" }),
      restart,
      newSession: () => send({ id: "new-session", type: "new_session" }),
      compact: () => send({ type: "compact" }),
      setModel: (model: string) => {
        const separator = model.indexOf("/");
        if (separator < 1) return;
        send({
          id: "set-model",
          type: "set_model",
          provider: model.slice(0, separator),
          modelId: model.slice(separator + 1),
        });
        send({ id: "state-after-model", type: "get_state" });
        send({ id: "thinking-after-model", type: "get_available_thinking_levels" });
      },
      cycleModel: () => {
        send({ id: "cycle-model", type: "cycle_model" });
        send({ id: "thinking-after-cycle", type: "get_available_thinking_levels" });
      },
      setThinking: (level: PiThinkingLevel) => {
        send({ id: "set-thinking", type: "set_thinking_level", level });
        send({ id: "state-after-thinking", type: "get_state" });
      },
      cycleThinking: () => send({ id: "cycle-thinking", type: "cycle_thinking_level" }),
      setSessionName: (name: string) => {
        send({ type: "set_session_name", name });
        send({ id: "state", type: "get_state" });
      },
      refreshTree: () => send({ id: "tree", type: "get_tree" }),
      fork: (entryId: string) => send({ id: "fork-session", type: "fork", entryId }),
      switchSession: (sessionPath: string) => {
        resumedSessions.set(paneId, sessionPath);
        send({ id: "switch-session", type: "switch_session", sessionPath });
      },
      answerDialog: (id, response) => {
        send({ type: "extension_ui_response", id, ...response });
        dispatch({ type: "dismissDialog", id });
      },
      dismissNotice: (id) => dispatch({ type: "dismissNotice", id }),
    }),
    [state, history, send, restart, paneId],
  );
}
