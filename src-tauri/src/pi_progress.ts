import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Keep these in sync with the renderer's progressMessages.ts; this file is injected standalone.
const KEY = "swath:progress";
const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 500;
interface ProgressEntry {
  id: string;
  message: string;
  timestamp: number;
  role?: "user" | "agent";
}

/** Projects existing user messages without persisting a duplicate or exposing image data. */
function userProgressEntry(entry: SessionEntry): ProgressEntry | null {
  if (entry.type !== "message" || entry.message.role !== "user") return null;
  const content = entry.message.content;
  const message =
    typeof content === "string"
      ? content
      : content
          .map((block) => (block.type === "text" ? block.text : "[Image attached]"))
          .join("\n");
  if (!message.trim()) return null;
  return { id: `user:${entry.id}`, message, timestamp: entry.message.timestamp, role: "user" };
}

/** Adds agent-written progress updates without changing Pi's model or execution scheduler. */
export default function progress(pi: ExtensionAPI): void {
  let messages: ProgressEntry[] = [];
  /** Publishes one complete snapshot so hosts never need to accumulate widget deltas. */
  const publish = (ctx: ExtensionContext): void => {
    ctx.ui.setWidget(
      KEY,
      messages.map((entry) =>
        ctx.mode === "rpc"
          ? JSON.stringify(entry)
          : `${entry.role === "user" ? "You" : "Agent"}: ${entry.message}`,
      ),
    );
  };
  /** Rebuilds the bounded list from the active branch on load or tree navigation. */
  const restore = (_event: unknown, ctx: ExtensionContext): void => {
    messages = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      const user = userProgressEntry(entry);
      if (user) {
        messages.push(user);
        messages = messages.slice(-MAX_MESSAGES);
        continue;
      }
      if (entry.type !== "custom" || entry.customType !== KEY) continue;
      const data = entry.data as Partial<ProgressEntry> | undefined;
      if (
        !data ||
        typeof data.id !== "string" ||
        !data.id ||
        typeof data.message !== "string" ||
        !data.message.trim() ||
        data.message.trim().length > MAX_MESSAGE_LENGTH ||
        typeof data.timestamp !== "number" ||
        !Number.isFinite(data.timestamp) ||
        data.timestamp < 0 ||
        data.timestamp > 8.64e15
      )
        continue;
      if (messages.some((message) => message.id === data.id)) continue;
      messages.push({ id: data.id, message: data.message.trim(), timestamp: data.timestamp });
      messages = messages.slice(-MAX_MESSAGES);
    }
    publish(ctx);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  // Message hooks run before Pi persists the user message. Provider requests and settlement
  // run afterward, so their snapshots can use the real session entry id without duplicates.
  pi.on("before_provider_request", restore);
  pi.on("agent_settled", restore);
  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      event.systemPrompt +
      "\n\nUse report_progress for initial intent on substantial work, meaningful milestones, findings or blockers, and verification. Keep updates concise; never include secrets or raw logs. It can run in the same parallel batch as unrelated work. Do not report every trivial call.",
  }));
  pi.registerTool({
    name: "report_progress",
    label: "Report Progress",
    description:
      "Report a concise progress update for the current session. Use 1 to 500 characters.",
    parameters: Type.Object({
      message: Type.String({
        description: "A short user-facing progress update. No secrets or raw logs.",
        minLength: 1,
        maxLength: MAX_MESSAGE_LENGTH,
      }),
    }),
    executionMode: "parallel",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    /** Commits each report before yielding, including when sibling tools execute in parallel. */
    async execute(
      toolCallId: string,
      params: { message: string },
      signal: AbortSignal | undefined,
      _update: AgentToolUpdateCallback<ProgressEntry> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<ProgressEntry>> {
      if (typeof params.message !== "string") throw new Error("Progress message must be a string.");
      const message = params.message.trim();
      if (!message || message.length > MAX_MESSAGE_LENGTH)
        throw new Error("Progress message must contain 1 to 500 characters.");
      if (signal?.aborted) throw new Error("Progress report cancelled.");
      const existing = messages.find((entry) => entry.id === toolCallId);
      const entry = existing ?? { id: toolCallId, message, timestamp: Date.now() };
      // Keep read-modify-persist-publish synchronous so parallel calls cannot lose updates.
      if (!existing) {
        pi.appendEntry(KEY, entry);
        messages = [...messages, entry].slice(-MAX_MESSAGES);
      }
      publish(ctx);
      return { content: [{ type: "text", text: entry.message }], details: entry };
    },
  });
}
