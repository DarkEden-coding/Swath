/**
 * Owns one `pi --mode rpc` child process for a pane: spawns it, feeds stdout lines through the
 * reducer, and exposes a typed `send`.
 *
 * State lives in `useReducer` rather than a store library because nothing outside this pane's
 * subtree reads it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

// The shared IPC union is updated by the host integration; keep this feature scoped to its owner.
const attachPi = (paneId: string): Promise<{ running: boolean }> =>
  window.swath.pi.rpc({ op: "attach", paneId } as unknown as Parameters<
    typeof window.swath.pi.rpc
  >[0]) as Promise<{ running: boolean }>;
import {
  parsePiLine,
  agentTabRequestFrom,
  type PiAgentTabRequest,
  type PiCommandMessage,
  type PiImageContent,
  type PiThinkingLevel,
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
import { reportQuestioning, reportStreaming } from "./piActivity";

type Action =
  | { type: "line"; line: string }
  | { type: "exit" }
  | { type: "error"; message: string }
  | { type: "dismissDialog"; id: string }
  | { type: "dismissNotice"; id: string }
  | { type: "reset" };

function reducer(state: PiPaneState, action: Action): PiPaneState {
  switch (action.type) {
    case "line": {
      const event = parsePiLine(action.line);
      return event ? reducePiEvent(state, event) : state;
    }
    case "exit":
      return { ...state, exited: true, isStreaming: false };
    case "error":
      return { ...state, error: action.message };
    case "dismissDialog":
      return dismissDialog(state, action.id);
    case "dismissNotice":
      return dismissNotice(state, action.id);
    case "reset":
      return initialPiPaneState();
    default:
      return state;
  }
}

export interface PiAgentController {
  state: PiPaneState;
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
  void attachPi(paneId)
    .then((result) => {
      if ((result as { running: boolean }).running) return;
      return window.swath.pi.rpc({ op: "spawn", paneId, cwd, args }).then(() =>
        window.swath.pi.rpc({
          op: "send",
          paneId,
          line: JSON.stringify({ type: "prompt", message: start.task }),
        }),
      );
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
): PiAgentController {
  useEffect(() => mountPiPaneEventCache(paneId), [paneId]);

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
  const restartingRef = useRef(false);
  const startupRef = useRef(0);

  // Republish every render so a remount (tab switch) restores the transcript synchronously.
  useEffect(() => {
    const entry = piPaneCache.get(paneId);
    piPaneCache.set(paneId, { draft: "", images: [], pastes: [], ...entry, state });
    reportStreaming(paneId, state.isStreaming);
    reportQuestioning(paneId, state.dialogs.length > 0);
  }, [paneId, state]);

  const send = useCallback(
    (command: PiCommandMessage) => {
      void window.swath.pi
        .rpc({ op: "send", paneId, line: JSON.stringify(command) })
        .catch((error: unknown) => {
          dispatch({ type: "error", message: String(error) });
        });
    },
    [paneId],
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

  const spawn = useCallback(() => {
    if (!cwd) return;
    // The backend owns the process; the local set only deduplicates concurrent mount attempts.
    spawnedPanes.add(paneId);
    const generation = ++startupRef.current;
    // Reopen the session this pane last reported. Legacy panes have no stored file, so continue
    // the newest session for their project once and persist the exact file from pi's state.
    const sessionFile = resumedSessions.get(paneId) ?? initialSessionFile;
    const isFreshStart = !sessionFile && Boolean(initialStart) && needsInitialPromptRef.current;
    const sessionArgs = sessionFile
      ? ["--session", sessionFile]
      : isFreshStart
        ? []
        : ["--continue"];
    const startupArgs = initialStart
      ? [
          ...(initialStart.title ? ["--name", initialStart.title] : []),
          ...(initialStart.model ? ["--model", initialStart.model] : []),
          ...(initialStart.reasoningLevel ? ["--thinking", initialStart.reasoningLevel] : []),
        ]
      : [];
    void attachPi(paneId)
      .then((attached) => {
        if (generation !== startupRef.current) return;
        if ((attached as { running: boolean }).running) {
          requestFullState();
          return;
        }
        return window.swath.pi
          .rpc({
            op: "spawn",
            paneId,
            cwd,
            args: [...sessionArgs, ...startupArgs, ...groupPathArgs(cwd, groupPathsRef.current)],
          })
          .then((result) => {
            if (generation !== startupRef.current) return;
            // The host rejects on failure, but a transport that resolves with `{ ok: false }`
            // (the browser fixture) must not leave the pane silently stuck on "Starting pi…".
            const failure = result as { ok?: boolean; error?: string } | null;
            if (failure && failure.ok === false) {
              spawnedPanes.delete(paneId);
              dispatch({ type: "error", message: failure.error ?? "Unable to start pi" });
              return;
            }
            dispatch({ type: "reset" });
            requestFullState();
            if (isFreshStart && initialStart) {
              needsInitialPromptRef.current = false;
              send({ type: "prompt", message: initialStart.task });
            }
          });
      })
      .catch((error: unknown) => {
        if (generation !== startupRef.current) return;
        restartingRef.current = false;
        if (String(error).includes("already running for pane")) {
          requestFullState();
          return;
        }
        spawnedPanes.delete(paneId);
        dispatch({ type: "error", message: String(error) });
      });
  }, [paneId, cwd, initialSessionFile, initialStart, requestFullState, send]);

  /** Explicit user restart: tear the child down first, then spawn a fresh one. */
  const restart = useCallback(() => {
    restartingRef.current = true;
    ++startupRef.current;
    spawnedPanes.delete(paneId);
    void window.swath.pi
      .rpc({ op: "kill", paneId })
      .then(spawn)
      .catch((error: unknown) => {
        restartingRef.current = false;
        dispatch({ type: "error", message: String(error) });
      });
  }, [paneId, spawn]);

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
        dispatch({ type: "error", message: String(error) });
      }
    });

    function handleLine(eventPaneId: string, line?: string, exited?: boolean): void {
      if (eventPaneId !== paneId) return;
      if (exited) {
        if (!restartingRef.current) dispatch({ type: "exit" });
        return;
      }
      if (!line) return;
      restartingRef.current = false;
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

  // A browser may miss streamed events while its socket is disconnected. Pi supplies a fresh
  // transcript and state after reconnect; the live subscription remains mounted.
  useEffect(() => {
    if (window.swath.platform !== "web") return;
    return window.swath.remote.onStatus((_id, status) => {
      if (status === "connected") requestFullState();
    });
  }, [requestFullState]);

  // No teardown on unmount: the pane is unmounted on every tab switch, and killing pi there is
  // what forced the reload. `piAgentTabType.closePane` disposes the pane for real.
  useEffect(() => {
    spawn();
  }, [spawn]);

  return useMemo<PiAgentController>(
    () => ({
      state,
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
    [state, send, restart, paneId],
  );
}
