import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PiIncoming } from "../../../../shared/ipc/piRpc";
import {
  dismissDialog,
  initialPiPaneState,
  reducePiEvent,
  type PiMessageEntry,
  type PiPaneState,
  type PiToolEntry,
} from "./eventReducer";

function run(events: PiIncoming[], from: PiPaneState = initialPiPaneState()): PiPaneState {
  return events.reduce(reducePiEvent, from);
}

/** A real `pi --mode rpc` turn: one prompt, one bash tool call, one text reply. */
function realTurn(): PiIncoming[] {
  const text = readFileSync(join(__dirname, "fixtures/turn.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PiIncoming);
}

describe("reducePiEvent against a real captured turn", () => {
  it("produces prompt, tool card and reply in order", () => {
    const state = run(realTurn());

    expect(state.entries.map((entry) => entry.kind)).toEqual(["message", "message", "tool", "message"]);

    const [prompt, toolCallMsg, tool, reply] = state.entries;
    expect((prompt as PiMessageEntry).role).toBe("user");
    expect((prompt as PiMessageEntry).text).toContain("echo hello");

    // The assistant turn that only emitted a toolCall block renders no text.
    expect((toolCallMsg as PiMessageEntry).text).toBe("");

    expect((tool as PiToolEntry).toolName).toBe("bash");
    expect((tool as PiToolEntry).args).toEqual({ command: "echo hello" });
    expect((tool as PiToolEntry).output).toBe("hello\n");
    expect((tool as PiToolEntry).isError).toBe(false);

    expect((reply as PiMessageEntry).text).toBe("done");
    expect((reply as PiMessageEntry).streaming).toBe(false);
  });

  it("does not double-render the tool call as both message and card", () => {
    const state = run(realTurn());
    const tools = state.entries.filter((entry) => entry.kind === "tool");
    expect(tools).toHaveLength(1);
    // toolResult-role messages must not become message entries.
    expect(state.entries.filter((entry) => entry.kind === "message")).toHaveLength(3);
  });

  it("captures assistant usage for the footer", () => {
    const state = run(realTurn());
    const reply = state.entries[3] as PiMessageEntry;
    expect(reply.usage?.input).toBeGreaterThan(0);
  });

  it("settles streaming state at the end of the turn", () => {
    const state = run(realTurn());
    expect(state.isStreaming).toBe(false);
  });
});

describe("history hydration from get_messages", () => {
  // Shapes taken from a real `get_messages` reply on a resumed session.
  const messages = [
    { role: "user" as const, content: [{ type: "text" as const, text: "run echo" }], timestamp: 1 },
    {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "call_1", name: "bash", arguments: { command: "echo hi" } }],
      timestamp: 2,
    },
    {
      role: "toolResult" as const,
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "hi\n" }],
      isError: false,
      timestamp: 3,
    },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }], timestamp: 4 },
  ];

  it("rebuilds messages and tool cards in order", () => {
    const state = run([
      { type: "response", command: "get_messages", success: true, data: { messages } },
    ]);

    expect(state.entries.map((entry) => entry.kind)).toEqual(["message", "tool", "message"]);
    const tool = state.entries[1] as PiToolEntry;
    expect(tool.toolName).toBe("bash");
    expect(tool.args).toEqual({ command: "echo hi" });
    // tool_execution_* is not replayed, so output must come from the toolResult message.
    expect(tool.output).toBe("hi\n");
    expect(tool.endedAt).toBe(3);
  });

  it("does not emit an empty message for a toolCall-only assistant turn", () => {
    const state = run([
      { type: "response", command: "get_messages", success: true, data: { messages } },
    ]);
    expect(state.entries.filter((entry) => entry.kind === "message")).toHaveLength(2);
  });

  it("still renders a result whose call was compacted away", () => {
    const state = run([
      {
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [messages[2]] },
      },
    ]);
    expect(state.entries).toHaveLength(1);
    expect((state.entries[0] as PiToolEntry).output).toBe("hi\n");
  });

  it("replaces rather than appends, so a re-hydrate does not duplicate", () => {
    let state = run([
      { type: "response", command: "get_messages", success: true, data: { messages } },
    ]);
    state = run(
      [{ type: "response", command: "get_messages", success: true, data: { messages } }],
      state,
    );
    expect(state.entries).toHaveLength(3);
  });

  it("keeps entry ids unique across hydrate and live events", () => {
    let state = run([
      { type: "response", command: "get_messages", success: true, data: { messages } },
    ]);
    state = run([{ type: "message_start", message: { role: "user", content: "next" } }], state);
    const ids = state.entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("reducePiEvent", () => {
  it("replaces cumulative message content rather than appending it", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
      {
        type: "message_update",
        message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
      },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Hello, world" }] },
      },
    ]);

    const message = state.entries[0] as PiMessageEntry;
    // Appending would produce "HelloHello, worldHello, world".
    expect(message.text).toBe("Hello, world");
    expect(message.streaming).toBe(false);
  });

  it("keeps thinking separate from text", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: [] } },
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "answer" },
          ],
        },
      },
    ]);

    const message = state.entries[0] as PiMessageEntry;
    expect(message.thinking).toBe("hmm");
    expect(message.text).toBe("answer");
  });

  it("reads plain-string user content", () => {
    const state = run([{ type: "message_start", message: { role: "user", content: "hi" } }]);
    expect((state.entries[0] as PiMessageEntry).text).toBe("hi");
  });

  it("replaces tool output on update because partialResult is cumulative", () => {
    const state = run([
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      {
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "line1\n" }] },
      },
      {
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "line1\nline2\n" }] },
      },
    ]);

    // Appending would produce "line1\nline1\nline2\n".
    expect((state.entries[0] as PiToolEntry).output).toBe("line1\nline2\n");
  });

  it("records tool completion, details and error state", () => {
    const state = run([
      { type: "tool_execution_start", toolCallId: "t1", toolName: "show_image" },
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "show_image",
        result: {
          content: [{ type: "text", text: "done" }],
          details: { path: "/tmp/a.png" },
        },
        isError: false,
      },
    ]);

    const tool = state.entries[0] as PiToolEntry;
    expect(tool.output).toBe("done");
    expect(tool.details).toEqual({ path: "/tmp/a.png" });
    expect(tool.endedAt).toBeTypeOf("number");
    expect(tool.isError).toBe(false);
  });

  it("interleaves tools and messages in arrival order", () => {
    const state = run([
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "running" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "running" }] } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash" },
      { type: "message_start", message: { role: "assistant", content: [] } },
    ]);

    expect(state.entries.map((entry) => entry.kind)).toEqual(["message", "tool", "message"]);
  });

  it("sets and clears extension status chips", () => {
    let state = run([
      {
        type: "extension_ui_request",
        id: "u1",
        method: "setStatus",
        statusKey: "parallel-agents",
        statusText: "subagents:5/5",
      },
    ]);
    expect(state.status["parallel-agents"]).toBe("subagents:5/5");

    state = run(
      [{ type: "extension_ui_request", id: "u2", method: "setStatus", statusKey: "parallel-agents" }],
      state,
    );
    expect(state.status["parallel-agents"]).toBeUndefined();
  });

  it("sets and clears widgets with their placement", () => {
    let state = run([
      {
        type: "extension_ui_request",
        id: "u1",
        method: "setWidget",
        widgetKey: "chat-banner-stats",
        widgetLines: ["Tools: 0"],
        widgetPlacement: "belowEditor",
      },
    ]);
    expect(state.widgets["chat-banner-stats"]).toEqual({
      key: "chat-banner-stats",
      lines: ["Tools: 0"],
      placement: "belowEditor",
    });

    state = run(
      [
        {
          type: "extension_ui_request",
          id: "u2",
          method: "setWidget",
          widgetKey: "chat-banner-stats",
        },
      ],
      state,
    );
    expect(state.widgets["chat-banner-stats"]).toBeUndefined();
  });

  it("queues blocking dialogs and dismisses them by id", () => {
    let state = run([
      {
        type: "extension_ui_request",
        id: "d1",
        method: "select",
        title: "Pick one",
        options: ["a", "b"],
      },
    ]);
    expect(state.dialogs).toHaveLength(1);

    state = dismissDialog(state, "d1");
    expect(state.dialogs).toHaveLength(0);
  });

  it("tracks streaming and compaction lifecycle", () => {
    let state = run([{ type: "agent_start" }]);
    expect(state.isStreaming).toBe(true);

    state = run([{ type: "compaction_start" }], state);
    expect(state.isCompacting).toBe(true);

    state = run([{ type: "compaction_end" }, { type: "agent_settled" }], state);
    expect(state.isCompacting).toBe(false);
    expect(state.isStreaming).toBe(false);
  });

  it("stores get_state and get_commands responses, and surfaces failures", () => {
    let state = run([
      {
        type: "response",
        command: "get_commands",
        success: true,
        data: { commands: [{ name: "todo", description: "d", source: "extension" }] },
      },
    ]);
    expect(state.commands).toHaveLength(1);

    state = run([{ type: "response", command: "prompt", success: false, error: "nope" }], state);
    expect(state.error).toBe("nope");
  });

  it("ignores unknown event types", () => {
    const before = initialPiPaneState();
    const after = reducePiEvent(before, { type: "wat" } as unknown as PiIncoming);
    expect(after).toBe(before);
  });
});
