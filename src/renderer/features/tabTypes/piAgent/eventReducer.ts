/**
 * Pure reduction of pi RPC events into renderable pane state.
 *
 * Kept free of React and transport concerns so the streaming assembly rules — which are the
 * only non-trivial logic in the pane — are directly testable.
 */

import type {
  PiCommand,
  PiContentBlock,
  PiExtensionUiRequest,
  PiIncoming,
  PiMessage,
  PiModel,
  PiSessionStats,
  PiState,
  PiThinkingLevel,
  PiToolResult,
  PiTreeNode,
  PiUsage,
} from "../../../../shared/ipc/piRpc";

export interface PiToolEntry {
  kind: "tool";
  id: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** Accumulated output text; `tool_execution_update` replaces rather than appends. */
  output: string;
  details?: Record<string, unknown>;
  startedAt: number;
  endedAt?: number;
  isError: boolean;
  /** Approval outcome published by the tool-review extension for this call. */
  reviewStatus?: string;
  reasoningLevel?: PiThinkingLevel;
  parallelGroup?: { id: string; index: number; total: number };
}

export interface PiMessageEntry {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  streaming: boolean;
  usage?: PiUsage;
  /** Failure line pi's TUI prints under the message; absent when the turn ended cleanly. */
  error?: string;
}

export type PiEntry = PiMessageEntry | PiToolEntry;

/** A fire-and-forget widget from `setWidget`. */
export interface PiWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface PiNotice {
  id: string;
  message: string;
  level: "info" | "warning" | "error";
}

/** A blocking dialog awaiting an `extension_ui_response`. */
export type PiDialog = Extract<
  PiExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

export interface PiPaneState {
  entries: PiEntry[];
  /** Extension status chips, keyed by `statusKey`; ANSI-colored strings. */
  status: Record<string, string>;
  widgets: Record<string, PiWidget>;
  notices: PiNotice[];
  dialogs: PiDialog[];
  commands: PiCommand[];
  models: PiModel[];
  thinkingLevels: PiThinkingLevel[];
  stats: PiSessionStats | null;
  tree: PiTreeNode[];
  treeLeafId?: string;
  state: PiState | null;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingCount: number;
  /** Text pi asked us to prefill into the composer, consumed by the UI. */
  editorText?: string;
  /** Latest tab title requested by an extension. */
  title?: string;
  exited: boolean;
  error?: string;
  /** Tool-call batches discovered while the assistant message streams. */
  toolGroups: Record<string, { id: string; index: number; total: number }>;
  /** Monotonic id source, kept in state so the reducer stays pure. */
  seq: number;
}

export function initialPiPaneState(): PiPaneState {
  return {
    entries: [],
    status: {},
    widgets: {},
    notices: [],
    dialogs: [],
    commands: [],
    models: [],
    thinkingLevels: [],
    stats: null,
    tree: [],
    state: null,
    isStreaming: false,
    isCompacting: false,
    pendingCount: 0,
    exited: false,
    toolGroups: {},
    seq: 0,
  };
}

/** Extracts plain text from a tool result's content blocks. */
function resultText(result: PiToolResult | undefined): string {
  if (!result?.content) return "";
  return result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function updateEntry(
  state: PiPaneState,
  match: (entry: PiEntry) => boolean,
  patch: (entry: PiEntry) => PiEntry,
): PiPaneState {
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (changed || !match(entry)) return entry;
    changed = true;
    return patch(entry);
  });
  return changed ? { ...state, entries } : state;
}

/** Messages carry no id, so updates target the one open message entry. */
function openMessageId(state: PiPaneState): string | undefined {
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (entry.kind === "message" && entry.streaming) return entry.id;
  }
  return undefined;
}

/**
 * Content blocks of a message, tolerating the shapes pi's own code calls out as possible:
 * "extension handlers can return messages with null/missing content".
 */
function contentBlocks(message: PiMessage): PiContentBlock[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as PiContentBlock[]) : [];
}

/** Flattens a message's content into displayable text and thinking. */
function readMessage(message: PiMessage): { text: string; thinking: string } {
  if (message.role === "user") {
    if (typeof message.content === "string") return { text: message.content, thinking: "" };
    return {
      text: contentBlocks(message)
        .filter(
          (block): block is Extract<PiContentBlock, { type: "text" }> => block.type === "text",
        )
        .map((block) => block.text)
        .join(""),
      thinking: "",
    };
  }
  if (message.role !== "assistant") return { text: "", thinking: "" };

  let text = "";
  let thinking = "";
  for (const block of contentBlocks(message)) {
    // toolCall blocks are deliberately skipped: they render as tool cards from
    // tool_execution_* instead, so they would otherwise appear twice.
    if (block.type === "text") text += block.text;
    else if (block.type === "thinking") thinking += block.thinking;
  }
  return { text, thinking };
}

/**
 * The failure line pi's TUI shows beneath an assistant message, or undefined when the turn ended
 * cleanly. Mirrors `modes/interactive/components/assistant-message.js`: aborted/error messages that
 * carry tool calls stay silent, because the tool cards already report the failure.
 */
export function messageError(message: PiMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "length") return "Response was truncated before completion.";
  if (contentBlocks(message).some((block) => block.type === "toolCall")) return undefined;
  if (message.stopReason === "aborted") {
    return message.errorMessage && message.errorMessage !== "Request was aborted"
      ? message.errorMessage
      : "Operation aborted";
  }
  if (message.stopReason === "error") return `Error: ${message.errorMessage || "Unknown error"}`;
  return undefined;
}

/** Records sibling tool calls so their cards can share one parallel frame. */
function recordToolGroups(state: PiPaneState, message: PiMessage): PiPaneState {
  if (message.role !== "assistant") return state;
  const calls = contentBlocks(message).filter(
    (block): block is Extract<PiContentBlock, { type: "toolCall" }> => block.type === "toolCall",
  );
  if (calls.length < 2) return state;

  const groupId = `parallel:${calls[0].id}`;
  const toolGroups = { ...state.toolGroups };
  calls.forEach((call, index) => {
    toolGroups[call.id] = { id: groupId, index, total: calls.length };
  });
  return { ...state, toolGroups };
}

function applyExtensionUi(state: PiPaneState, event: PiExtensionUiRequest): PiPaneState {
  switch (event.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return { ...state, dialogs: [...state.dialogs, event] };

    case "notify":
      return {
        ...state,
        seq: state.seq + 1,
        notices: [
          ...state.notices,
          {
            id: `notice-${state.seq}`,
            message: event.message,
            level: event.notifyType ?? "info",
          },
        ],
      };

    case "setStatus": {
      const toolCallId = event.statusKey.startsWith("tool-review:")
        ? event.statusKey.slice("tool-review:".length)
        : undefined;
      if (toolCallId) {
        return updateEntry(
          state,
          (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
          (entry) => ({ ...(entry as PiToolEntry), reviewStatus: event.statusText }),
        );
      }
      const status = { ...state.status };
      if (event.statusText === undefined) delete status[event.statusKey];
      else status[event.statusKey] = event.statusText;
      return { ...state, status };
    }

    case "setWidget": {
      const widgets = { ...state.widgets };
      if (event.widgetLines === undefined) {
        delete widgets[event.widgetKey];
      } else {
        widgets[event.widgetKey] = {
          key: event.widgetKey,
          lines: event.widgetLines,
          placement: event.widgetPlacement ?? "aboveEditor",
        };
      }
      return { ...state, widgets };
    }

    case "set_editor_text":
      return { ...state, editorText: event.text };

    case "setTitle":
      return { ...state, title: event.title };

    default:
      return state;
  }
}

/** Applies one pi event. Unknown event types leave state untouched. */
export function reducePiEvent(state: PiPaneState, event: PiIncoming): PiPaneState {
  switch (event.type) {
    case "message_start": {
      // toolResult and bashExecution messages duplicate the tool_execution_* cards.
      const role = event.message?.role;
      if (role !== "user" && role !== "assistant") return state;
      const { text, thinking } = readMessage(event.message);
      const entry: PiMessageEntry = {
        kind: "message",
        id: `msg-${state.seq}`,
        role,
        text,
        thinking,
        streaming: true,
      };
      return { ...state, seq: state.seq + 1, entries: [...state.entries, entry] };
    }

    case "message_update":
    case "message_end": {
      const role = event.message?.role;
      if (role !== "user" && role !== "assistant") return state;
      const targetId = openMessageId(state);
      if (!targetId) return state;
      // content is cumulative, so replace rather than append.
      const { text, thinking } = readMessage(event.message);
      const usage = role === "assistant" ? event.message.usage : undefined;
      const closing = event.type === "message_end";
      const groupedState = recordToolGroups(state, event.message);
      return updateEntry(
        groupedState,
        (entry) => entry.kind === "message" && entry.id === targetId,
        (entry) => ({
          ...(entry as PiMessageEntry),
          text,
          thinking,
          usage: usage ?? (entry as PiMessageEntry).usage,
          error: messageError(event.message),
          streaming: !closing,
        }),
      );
    }

    case "tool_execution_start": {
      const entry: PiToolEntry = {
        kind: "tool",
        id: event.toolCallId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        output: "",
        startedAt: Date.now(),
        isError: false,
        reasoningLevel: state.state?.thinkingLevel,
        parallelGroup: state.toolGroups[event.toolCallId],
      };
      return { ...state, entries: [...state.entries, entry] };
    }

    case "tool_execution_update":
      // partialResult is cumulative, so replace rather than append.
      return updateEntry(
        state,
        (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId,
        (entry) => ({
          ...(entry as PiToolEntry),
          output: resultText(event.partialResult),
          details: event.partialResult?.details ?? (entry as PiToolEntry).details,
        }),
      );

    case "tool_execution_end":
      return updateEntry(
        state,
        (entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId,
        (entry) => ({
          ...(entry as PiToolEntry),
          output: resultText(event.result) || (entry as PiToolEntry).output,
          details: event.result?.details ?? (entry as PiToolEntry).details,
          endedAt: Date.now(),
          isError: event.isError === true,
        }),
      );

    case "agent_start":
      return { ...state, isStreaming: true };

    case "agent_settled":
      return { ...state, isStreaming: false };

    case "queue_update":
      return {
        ...state,
        pendingCount:
          event.pending ?? (event.steering?.length ?? 0) + (event.followUp?.length ?? 0),
      };

    case "compaction_start":
      return { ...state, isCompacting: true };

    case "compaction_end":
      return { ...state, isCompacting: false };

    case "extension_error":
      return {
        ...state,
        seq: state.seq + 1,
        notices: [
          ...state.notices,
          { id: `notice-${state.seq}`, message: event.error ?? "Extension error", level: "error" },
        ],
      };

    case "extension_ui_request":
      return applyExtensionUi(state, event);

    case "response": {
      if (!event.success) {
        return { ...state, error: event.error ?? `${event.command} failed` };
      }
      if (event.command === "get_state") {
        const piState = event.data as PiState;
        return {
          ...state,
          state: piState,
          isStreaming: piState.isStreaming,
          isCompacting: piState.isCompacting,
        };
      }
      if (event.command === "set_model") {
        return state.state
          ? { ...state, state: { ...state.state, model: event.data as PiModel } }
          : state;
      }
      if (event.command === "cycle_model") {
        const data = event.data as
          { model?: PiModel; thinkingLevel?: PiThinkingLevel } | null | undefined;
        return state.state && data?.model
          ? {
              ...state,
              state: {
                ...state.state,
                model: data.model,
                thinkingLevel: data.thinkingLevel ?? state.state.thinkingLevel,
              },
            }
          : state;
      }
      if (event.command === "set_thinking_level") {
        return state;
      }
      if (event.command === "cycle_thinking_level") {
        const data = event.data as { level?: PiThinkingLevel } | null | undefined;
        return state.state && data?.level
          ? { ...state, state: { ...state.state, thinkingLevel: data.level } }
          : state;
      }
      if (event.command === "get_commands") {
        const data = event.data as { commands?: PiCommand[] } | undefined;
        return { ...state, commands: data?.commands ?? [] };
      }
      if (event.command === "get_messages") {
        const data = event.data as { messages?: PiMessage[] } | undefined;
        return hydrateFromMessages(state, data?.messages ?? []);
      }
      if (event.command === "get_available_models") {
        const data = event.data as { models?: PiModel[] } | undefined;
        return { ...state, models: data?.models ?? [] };
      }
      if (event.command === "get_available_thinking_levels") {
        const data = event.data as { levels?: PiThinkingLevel[] } | undefined;
        return { ...state, thinkingLevels: data?.levels ?? [] };
      }
      if (event.command === "get_session_stats") {
        return { ...state, stats: event.data as PiSessionStats };
      }
      if (event.command === "get_tree") {
        const data = event.data as { tree?: PiTreeNode[]; leafId?: string } | undefined;
        return { ...state, tree: data?.tree ?? [], treeLeafId: data?.leafId };
      }
      return state;
    }

    default:
      return state;
  }
}

/**
 * Rebuilds the transcript from a `get_messages` reply, so a pane reattached to an existing pi
 * session shows its history.
 *
 * History needs a different path from the live stream: `tool_execution_*` events are not replayed,
 * so tool cards are reconstructed from assistant `toolCall` blocks and the matching `toolResult`
 * messages. Replaces any existing entries — this runs once, right after spawn.
 */
export function hydrateFromMessages(state: PiPaneState, messages: PiMessage[]): PiPaneState {
  const entries: PiEntry[] = [];
  const toolsByCallId = new Map<string, PiToolEntry>();
  let seq = state.seq;

  for (const message of messages) {
    if (!message) continue;
    if (message.role === "user" || message.role === "assistant") {
      const { text, thinking } = readMessage(message);
      const error = messageError(message);
      if (text || thinking || error) {
        entries.push({
          kind: "message",
          id: `msg-${seq++}`,
          role: message.role,
          text,
          thinking,
          streaming: false,
          usage: message.role === "assistant" ? message.usage : undefined,
          error,
        });
      }
      if (message.role === "assistant") {
        const calls = contentBlocks(message).filter(
          (block): block is Extract<PiContentBlock, { type: "toolCall" }> =>
            block.type === "toolCall",
        );
        const groupId = calls.length > 1 ? `parallel:${calls[0].id}` : undefined;
        calls.forEach((block, index) => {
          const tool: PiToolEntry = {
            kind: "tool",
            id: block.id,
            toolCallId: block.id,
            toolName: block.name,
            args: block.arguments,
            output: "",
            startedAt: message.timestamp ?? 0,
            isError: false,
            parallelGroup: groupId ? { id: groupId, index, total: calls.length } : undefined,
          };
          toolsByCallId.set(block.id, tool);
          entries.push(tool);
        });
      }
      continue;
    }

    if (message.role === "toolResult") {
      const tool = toolsByCallId.get(message.toolCallId);
      const output = (message.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      if (tool) {
        tool.output = output;
        tool.isError = message.isError === true;
        tool.endedAt = message.timestamp ?? tool.startedAt;
      } else {
        // A result with no recorded call (compacted history) still deserves a card.
        entries.push({
          kind: "tool",
          id: message.toolCallId,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          output,
          startedAt: message.timestamp ?? 0,
          endedAt: message.timestamp ?? 0,
          isError: message.isError === true,
        });
      }
    }
  }

  return { ...state, entries, seq };
}

/** Removes a resolved dialog once its response has been sent. */
export function dismissDialog(state: PiPaneState, id: string): PiPaneState {
  return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== id) };
}

/** Drops a notice after it has been shown. */
export function dismissNotice(state: PiPaneState, id: string): PiPaneState {
  return { ...state, notices: state.notices.filter((notice) => notice.id !== id) };
}
