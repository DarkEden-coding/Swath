/**
 * Owns one `pi --mode rpc` child process for a pane: spawns it, feeds stdout lines through the
 * reducer, and exposes a typed `send`.
 *
 * State lives in `useReducer` rather than a store library because nothing outside this pane's
 * subtree reads it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  parsePiLine,
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
import { piPaneCache, resumedSessions, spawnedPanes } from "./piPaneCache";

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
 * @param onShowImage called when the agent runs the Swath `show_image` tool. In RPC mode the
 * extension's OSC 777 channel is unavailable (stdout carries the protocol), so the path is read
 * from the tool result's `details` instead.
 */
export function usePiAgent(
  paneId: string,
  cwd: string | undefined,
  onShowImage?: (path: string) => void,
): PiAgentController {
  const [state, dispatch] = useReducer(
    reducer,
    paneId,
    (id) => piPaneCache.get(id)?.state ?? initialPiPaneState(),
  );

  // Republish every render so a remount (tab switch) restores the transcript synchronously.
  useEffect(() => {
    const entry = piPaneCache.get(paneId);
    piPaneCache.set(paneId, { draft: "", images: [], ...entry, state });
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

  /** The startup handshake, also used to resync a pane that was hidden while pi kept working. */
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
    // The process outlives an unmount: reattach and pull anything missed while hidden.
    if (spawnedPanes.has(paneId)) {
      requestFullState();
      return;
    }
    spawnedPanes.add(paneId);
    dispatch({ type: "reset" });
    // The pane id doubles as the pi session id: it is stable and already persisted in the
    // layout, so a remounted or restored pane reattaches to its own conversation.
    // `--session-id` creates the session when it does not exist yet. A pane that adopted another
    // session through `/resume` opens that file instead — the two flags are mutually exclusive.
    const resumed = resumedSessions.get(paneId);
    void window.swath.pi
      .rpc({
        op: "spawn",
        paneId,
        cwd,
        args: resumed ? ["--session", resumed] : ["--session-id", paneId],
      })
      .then((result) => {
        // The host rejects on failure, but a transport that resolves with `{ ok: false }`
        // (the browser fixture) must not leave the pane silently stuck on "Starting pi…".
        const failure = result as { ok?: boolean; error?: string } | null;
        if (failure && failure.ok === false) {
          spawnedPanes.delete(paneId);
          dispatch({ type: "error", message: failure.error ?? "Unable to start pi" });
          return;
        }
        requestFullState();
      })
      .catch((error: unknown) => {
        spawnedPanes.delete(paneId);
        dispatch({ type: "error", message: String(error) });
      });
  }, [paneId, cwd, requestFullState]);

  /** Explicit user restart: tear the child down first, then spawn a fresh one. */
  const restart = useCallback(() => {
    spawnedPanes.delete(paneId);
    void window.swath.pi.rpc({ op: "kill", paneId }).finally(spawn);
  }, [paneId, spawn]);

  // Kept in refs so the subscription is created once per pane rather than on every render.
  const showImageRef = useRef(onShowImage);
  const sendRef = useRef(send);
  useEffect(() => {
    showImageRef.current = onShowImage;
    sendRef.current = send;
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
        dispatch({ type: "exit" });
        return;
      }
      if (!line) return;
      dispatch({ type: "line", line });

      const event = parsePiLine(line);
      if (!event) return;

      // Swath integration tools signal through result.details, not OSC — see
      // docs/features/pi-agent-pane.md §3.3.
      if (event.type === "tool_execution_end" && event.toolName === "show_image") {
        const path = event.result?.details?.path;
        if (typeof path === "string" && path) showImageRef.current?.(path);
      }

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

      // Refresh the footer once the run is fully settled, when totals are final.
      if (event.type === "agent_settled") {
        sendRef.current({ id: "stats", type: "get_session_stats" });
        sendRef.current({ id: "state", type: "get_state" });
      }
    }

    return unsubscribe;
  }, [paneId]);

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
