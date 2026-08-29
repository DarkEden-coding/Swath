/**
 * Types for the `piAgent` pane's transport to a `pi --mode rpc` child process.
 *
 * The Rust side forwards stdin/stdout lines verbatim and never parses the pi protocol, so
 * everything below is renderer-side typing only. There are no runtime validators here: unlike
 * `gitRpc`, no renderer input reaches a shell — pi validates its own commands and replies with
 * `{ success: false, error }`.
 */

/** Renderer → host process-control requests. */
export type PiRpcRequest =
  | { op: "spawn"; paneId: string; cwd: string; args?: string[] }
  | { op: "send"; paneId: string; line: string }
  | { op: "kill"; paneId: string }
  | { op: "stderr"; paneId: string }
  /**
   * Bounded file walk for `@file` completion: `cwd` yields relative paths, and the other folders
   * of a project group yield absolute ones, which is what a mention needs to reach outside `cwd`.
   */
  | { op: "files"; paneId: string; cwd: string; paths?: readonly string[] }
  /** Lists the pi session files in `dir`, for `/resume`. */
  | { op: "sessions"; paneId: string; dir: string };

/** One entry of the `sessions` reply. */
export interface PiSessionInfo {
  path: string;
  id: string;
  name: string | null;
  preview: string;
  messages: number;
  /** Unix epoch milliseconds. */
  modified: number;
}

/** Host → renderer stdout record, or the process-exit notice. */
export type PiHostEvent = { paneId: string; line?: string; exit?: true };

// --- pi protocol (subset used by the pane) -------------------------------------------------

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  input?: string[];
}

/** Payload emitted by Swath's Pi extension to request an independent agent tab. */
export interface PiAgentTabRequest {
  task: string;
  title?: string;
  model?: string;
  reasoningLevel?: PiThinkingLevel;
}

const AGENT_TAB_STATUS_KEY = "swath:create-agent-tab";

/** Parses the private extension-UI signal used for Swath agent-tab creation. */
export function agentTabRequestFrom(event: PiIncoming): PiAgentTabRequest | null {
  if (
    event.type !== "extension_ui_request" ||
    event.method !== "setStatus" ||
    event.statusKey !== AGENT_TAB_STATUS_KEY ||
    !event.statusText
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(event.statusText);
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { task?: unknown }).task !== "string" ||
      !(value as { task: string }).task.trim()
    ) {
      return null;
    }
    const request = value as Record<string, unknown>;
    return {
      task: request.task as string,
      ...(typeof request.title === "string" && request.title.trim()
        ? { title: request.title }
        : {}),
      ...(typeof request.model === "string" && request.model.trim()
        ? { model: request.model }
        : {}),
      ...(typeof request.reasoningLevel === "string" &&
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.reasoningLevel)
        ? { reasoningLevel: request.reasoningLevel as PiThinkingLevel }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface PiState {
  model: PiModel | null;
  thinkingLevel: PiThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionId?: string;
  sessionName?: string;
  sessionFile?: string;
  messageCount: number;
  pendingMessageCount: number;
  autoCompactionEnabled: boolean;
}

export interface PiCommand {
  name: string;
  description: string;
  source: "extension" | "skill" | "builtin" | string;
}

/** `get_session_stats` payload. */
export interface PiSessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

/** One node of the `get_tree` reply. */
export interface PiTreeNode {
  entry: {
    type: string;
    id: string;
    parentId: string | null;
    timestamp?: string;
    [key: string]: unknown;
  };
  children: PiTreeNode[];
}

/** Image attachment for `prompt` / `steer` / `follow_up`. */
export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Commands written to pi stdin. Not exhaustive — pi accepts more than the pane sends. */
export type PiCommandMessage =
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: PiImageContent[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { id?: string; type: "follow_up"; message: string; images?: PiImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session" }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "get_available_thinking_levels" }
  | { id?: string; type: "clone" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "set_thinking_level"; level: PiThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "compact" }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "set_session_name"; name: string }
  | {
      type: "extension_ui_response";
      id: string;
      value?: string;
      confirmed?: boolean;
      cancelled?: true;
    };

/** Tool result payload carried by `tool_execution_*`. */
export interface PiToolResult {
  content?: { type: string; text?: string }[];
  details?: Record<string, unknown>;
}

/** A content block inside an assistant message. */
export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> };

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: { total: number };
}

/**
 * A message as carried by `message_start` / `message_update` / `message_end`.
 *
 * `content` is always the *complete* current content, not a delta — verified against a real
 * stream (see `fixtures/turn.jsonl`), so consumers replace rather than accumulate.
 */
export type PiMessage =
  | { role: "user"; content: string | PiContentBlock[]; timestamp?: number }
  | {
      role: "assistant";
      content: PiContentBlock[];
      model?: string;
      provider?: string;
      usage?: PiUsage;
      stopReason?: string;
      /** Present when `stopReason` is `error` / `aborted`; pi's TUI renders it as `Error: …`. */
      errorMessage?: string;
      timestamp?: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content?: { type: string; text?: string }[];
      isError?: boolean;
      timestamp?: number;
    }
  | { role: "bashExecution"; command: string; output?: string; timestamp?: number };

/** Delta carried by current Pi RPC `message_update` events. */
export interface PiAssistantMessageEvent {
  type:
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
    | string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  toolCall?: Extract<PiContentBlock, { type: "toolCall" }>;
}

/** Records read from pi stdout. Unknown `type` values are ignored by the reducer. */
export type PiIncoming =
  | {
      type: "response";
      id?: string;
      command: string;
      success: boolean;
      data?: unknown;
      error?: string;
    }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: PiMessage }
  | { type: "message_update"; message?: PiMessage; assistantMessageEvent?: PiAssistantMessageEvent }
  | { type: "message_end"; message: PiMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      partialResult?: PiToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: PiToolResult;
      isError?: boolean;
    }
  | { type: "queue_update"; pending?: number; steering?: string[]; followUp?: string[] }
  | { type: "compaction_start"; reason?: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      reason?: "manual" | "threshold" | "overflow";
      aborted?: boolean;
      errorMessage?: string;
      willRetry?: boolean;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "summarization_retry_scheduled";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | {
      type: "summarization_retry_attempt_start";
      source: "compaction" | "branchSummary";
      reason?: "manual" | "threshold" | "overflow";
    }
  | { type: "summarization_retry_finished" }
  | { type: "extension_error"; error?: string }
  | PiExtensionUiRequest;

/** Extension UI sub-protocol request (dialogs block until answered; the rest are fire-and-forget). */
export type PiExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
} & (
  | { method: "select"; title?: string; options: string[]; timeout?: number }
  | { method: "confirm"; title?: string; message?: string; timeout?: number }
  | { method: "input"; title?: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title?: string; prefill?: string; timeout?: number }
  | { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { method: "setStatus"; statusKey: string; statusText?: string }
  | {
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
);

/** Parses one stdout line. Returns null for malformed JSON rather than throwing. */
export function parsePiLine(line: string): PiIncoming | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    if (typeof (value as { type?: unknown }).type !== "string") return null;
    return value as PiIncoming;
  } catch {
    return null;
  }
}
