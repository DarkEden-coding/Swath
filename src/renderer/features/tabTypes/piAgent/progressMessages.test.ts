import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialPiPaneState, reducePiEvent } from "./eventReducer";
import { ProgressWindow, progressScrollTop } from "./ProgressWindow";
import { buildRows } from "./Transcript";
import type { PiToolEntry } from "./eventReducer";
import { MAX_PROGRESS_MESSAGES, PROGRESS_KEY, type PiProgressMessage } from "./progressMessages";

function message(id: string): PiProgressMessage {
  return { id, message: `Update ${id}`, timestamp: 1_000 };
}

function snapshot(messages: PiProgressMessage[], from = initialPiPaneState()) {
  return reducePiEvent(from, {
    type: "extension_ui_request",
    id: "widget",
    method: "setWidget",
    widgetKey: PROGRESS_KEY,
    widgetLines: messages.map((entry) => JSON.stringify(entry)),
  });
}

function entry(id: string, parentId: string | null, progress: PiProgressMessage) {
  return { id, parentId, type: "custom", customType: PROGRESS_KEY, data: progress };
}

describe("agent progress", () => {
  it("routes live snapshots to the floating list, not the generic widget stack", () => {
    const state = snapshot([message("a"), message("b")]);
    expect(state.progressMessages).toEqual([message("a"), message("b")]);
    expect(state.widgets[PROGRESS_KEY]).toBeUndefined();
    expect(state.entries).toEqual([]);
    expect(snapshot([], state).progressMessages).toEqual([]);
  });

  it("bounds and deduplicates updates, rejecting malformed widget data", () => {
    const state = snapshot(Array.from({ length: 60 }, (_, index) => message(String(index))));
    expect(state.progressMessages).toHaveLength(MAX_PROGRESS_MESSAGES);
    expect(state.progressMessages[0].id).toBe("10");
    const invalid = reducePiEvent(state, {
      type: "extension_ui_request",
      id: "widget",
      method: "setWidget",
      widgetKey: PROGRESS_KEY,
      widgetLines: [
        "not JSON",
        JSON.stringify(message("a")),
        JSON.stringify(message("a")),
        JSON.stringify({ ...message("bad"), timestamp: Infinity }),
        JSON.stringify({ ...message("long"), message: "x".repeat(501) }),
      ],
    });
    expect(invalid.progressMessages).toEqual([message("a")]);
  });

  it("restores only the active branch after reconnect and preserves newer live events", () => {
    const state = snapshot([message("a"), message("abandoned"), message("live")]);
    const restored = reducePiEvent(state, {
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: [
          entry("a", null, message("a")),
          entry("abandoned", "a", message("abandoned")),
          { id: "compact", parentId: "a", type: "compaction" },
          entry("b", "compact", message("b")),
        ],
        leafId: "b",
      },
    });
    expect(restored.progressMessages).toEqual([message("a"), message("b"), message("live")]);
  });

  it("restores user messages between agent updates, including long text and image placeholders", () => {
    const user = {
      id: "prompt",
      parentId: null,
      type: "message",
      message: { role: "user", content: "Start investigating", timestamp: 500 },
    };
    const followUp = {
      id: "follow-up",
      parentId: "report",
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(800) },
          { type: "image", data: "image-data", mimeType: "image/png" },
        ],
        timestamp: 1500,
      },
    };
    const abandoned = {
      id: "abandoned-user",
      parentId: "prompt",
      type: "message",
      message: { role: "user", content: "Other branch", timestamp: 900 },
    };
    const waiting = snapshot([
      { id: "user:abandoned-user", role: "user", message: "Other branch", timestamp: 900 },
    ]);
    const restored = reducePiEvent(waiting, {
      type: "response",
      command: "get_entries",
      success: true,
      data: {
        entries: [user, entry("report", "prompt", message("report")), followUp, abandoned],
        leafId: "follow-up",
      },
    });
    expect(restored.progressMessages).toEqual([
      { id: "user:prompt", message: "Start investigating", timestamp: 500, role: "user" },
      message("report"),
      {
        id: "user:follow-up",
        message: "x".repeat(800) + "\n[Image attached]",
        timestamp: 1500,
        role: "user",
      },
    ]);
    expect(snapshot(restored.progressMessages).progressMessages).toEqual(restored.progressMessages);
    expect(JSON.stringify(restored.progressMessages)).not.toContain("image-data");
  });

  it("keeps the latest messages across compaction and drops progress when a new session publishes empty state", () => {
    const entries = Array.from({ length: 70 }, (_, index) =>
      entry(String(index), index === 0 ? null : String(index - 1), message(String(index))),
    );
    const restored = reducePiEvent(initialPiPaneState(), {
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries, leafId: "69" },
    });
    expect(restored.progressMessages).toHaveLength(50);
    expect(restored.progressMessages[0].id).toBe("20");
    expect(snapshot([], restored).progressMessages).toEqual([]);
  });

  it("does not hang on broken history or erase live progress on a malformed response", () => {
    const state = snapshot([message("live")]);
    expect(
      reducePiEvent(state, { type: "response", command: "get_entries", success: true, data: {} })
        .progressMessages,
    ).toEqual(state.progressMessages);
    const restored = reducePiEvent(state, {
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [entry("cycle", "cycle", message("old"))], leafId: "cycle" },
    });
    expect(restored.progressMessages).toEqual([message("old"), message("live")]);
  });

  it("keeps progress reports visible alongside their parallel transcript siblings", () => {
    const tool = (name: string, index: number): PiToolEntry => ({
      kind: "tool",
      id: String(index),
      toolCallId: String(index),
      toolName: name,
      output: "done",
      phase: "completed",
      startedAt: 1,
      endedAt: 2,
      isError: false,
      parallelGroup: { id: "batch", index, total: 3 },
    });
    const progress = tool("report_progress", 1);
    const rows = buildRows([tool("read", 0), progress, tool("bash", 2)], "/tmp");
    expect(rows).toHaveLength(1);
    const html = renderToStaticMarkup(rows[0].node);
    expect(html).toContain("read");
    expect(html).toContain("bash");
    expect(html).toContain("report_progress");
    expect(buildRows([progress], "/tmp")).toHaveLength(1);
    expect(buildRows([{ ...progress, isError: true }], "/tmp")).toHaveLength(1);
  });

  it("follows the bottom or preserves a manually scrolled item as messages are added or trimmed", () => {
    expect(progressScrollTop(true, 100, 500, 200)).toBe(300);
    expect(progressScrollTop(true, 300, 700, 200)).toBe(500);
    expect(progressScrollTop(false, 100, 700, 200)).toBe(100);
    // A retained visible item moves up by 60px when the oldest message is trimmed.
    expect(progressScrollTop(false, 100, 700, 200, -60)).toBe(40);
    // Wrapping above the visible item adds height without changing what the user is reading.
    expect(progressScrollTop(false, 100, 700, 200, 30)).toBe(130);
    expect(progressScrollTop(true, 0, 100, 200)).toBe(0);
  });

  it("renders escaped updates oldest first and keeps a hidden window hidden as updates arrive", () => {
    const messages = [
      { ...message("old"), role: "user" as const },
      { ...message("new"), message: "<script>unsafe</script>" },
    ];
    const render = (hidden: boolean, updates = messages) =>
      renderToStaticMarkup(
        createElement(ProgressWindow, { messages: updates, hidden, onHiddenChange: () => {} }),
      );
    const shown = render(false);
    expect(shown).toContain('aria-label="Hide progress"');
    expect(shown).toContain(">You</span>");
    expect(shown).toContain(">Agent</span>");
    expect(shown).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(shown.indexOf("Update old")).toBeLessThan(shown.indexOf("unsafe"));
    const hidden = render(true, [...messages, message("latest")]);
    expect(hidden).toContain('aria-label="Show progress, 3 updates"');
    expect(hidden).not.toContain("Update latest");
    expect(render(false, [])).toBe("");
  });
});
