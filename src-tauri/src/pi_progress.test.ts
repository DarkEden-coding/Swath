import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("typebox", () => ({
  Type: {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: () => ({ type: "string" }),
  },
}));
import progress from "./pi_progress";

function fixture() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let tool: any;
  let branch: any[] = [];
  const appendEntry = vi.fn((customType, data) =>
    branch.push({ type: "custom", customType, data }),
  );
  progress({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (value: any) => {
      tool = value;
    },
    appendEntry,
  } as unknown as ExtensionAPI);
  const setWidget = vi.fn();
  const ctx = { mode: "rpc", ui: { setWidget }, sessionManager: { getBranch: () => branch } };
  const fire = (name: string, event = {}) => handlers.get(name)!(event, ctx);
  const call = (id: string, message: unknown, signal?: AbortSignal) =>
    tool.execute(id, { message }, signal, undefined, ctx);
  const snapshot = () => setWidget.mock.lastCall![1].map((line: string) => JSON.parse(line));
  const replace = (entries: any[]) => {
    branch = entries;
  };
  return { tool, appendEntry, setWidget, ctx, fire, call, snapshot, replace };
}
const saved = (id: string, message = id) => ({
  type: "custom",
  customType: "swath:progress",
  data: { id, message, timestamp: 123 },
});

describe("Pi progress", () => {
  it("keeps parallel reports alongside unrelated async work and persists each only once", async () => {
    const f = fixture();
    expect(f.tool.executionMode).toBe("parallel");
    expect(f.tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    await Promise.all([
      f.call("a", " first "),
      Promise.resolve().then(() => "unrelated"),
      f.call("b", "second"),
      f.call("c", "third"),
    ]);
    expect(f.snapshot().map((entry: any) => entry.message)).toEqual(["first", "second", "third"]);
    expect(f.appendEntry).toHaveBeenCalledTimes(3);
    expect(f.appendEntry).toHaveBeenCalledWith("swath:progress", {
      id: "a",
      message: "first",
      timestamp: expect.any(Number),
    });
    const retry = await f.call("a", "different");
    expect(retry.details.message).toBe("first");
    expect(f.appendEntry).toHaveBeenCalledTimes(3);
  });

  it("restores only the active branch, clears replaced sessions and renders readable TUI lines", async () => {
    const f = fixture();
    await f.call("old", "old session");
    f.replace([saved("branch"), { ...saved("ignored"), customType: "other" }, saved("branch")]);
    f.fire("session_start");
    expect(f.snapshot()).toEqual([saved("branch").data]);
    await f.call("branch", "retry");
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
    f.replace([saved("sibling")]);
    f.fire("session_tree");
    expect(f.snapshot()).toEqual([saved("sibling").data]);
    f.replace([]);
    f.fire("session_start");
    expect(f.snapshot()).toEqual([]);
    f.ctx.mode = "interactive";
    await f.call("tui", "Human readable");
    expect(f.setWidget).toHaveBeenLastCalledWith("swath:progress", ["Agent: Human readable"]);
  });

  it("interleaves persisted user messages with reports without duplicating user history", async () => {
    const f = fixture();
    const user = {
      type: "message",
      id: "user-one",
      message: {
        role: "user",
        content: "Please investigate",
        timestamp: 100,
      },
    };
    const image = {
      type: "message",
      id: "user-two",
      message: {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(800) },
          { type: "image", data: "raw-image-data", mimeType: "image/png" },
        ],
        timestamp: 200,
      },
    };
    f.replace([user, saved("report"), image]);
    f.fire("before_provider_request");
    expect(f.snapshot()).toEqual([
      { id: "user:user-one", message: "Please investigate", timestamp: 100, role: "user" },
      saved("report").data,
      {
        id: "user:user-two",
        message: "x".repeat(800) + "\n[Image attached]",
        timestamp: 200,
        role: "user",
      },
    ]);
    expect(JSON.stringify(f.snapshot())).not.toContain("raw-image-data");
    await f.call("next", "Investigating the follow-up");
    f.fire("agent_settled");
    expect(f.snapshot().map((entry: any) => entry.id)).toEqual([
      "user:user-one",
      "report",
      "user:user-two",
      "next",
    ]);
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
    f.fire("agent_settled");
    expect(f.snapshot()).toHaveLength(4);
  });

  it("rejects invalid or cancelled updates without persistence or publishing", async () => {
    const f = fixture();
    for (const message of ["", "  \n ", "x".repeat(501), undefined, 5]) {
      await expect(f.call("bad", message)).rejects.toThrow();
    }
    const controller = new AbortController();
    controller.abort();
    await expect(f.call("cancelled", "valid", controller.signal)).rejects.toThrow("cancelled");
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.setWidget).not.toHaveBeenCalled();
    await f.call("limit", ` ${"x".repeat(500)} `);
    expect(f.snapshot()[0].message).toHaveLength(500);
  });

  it("bounds both live and restored lists at 50 without snapshot persistence", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 55 }, (_, i) => f.call(String(i), String(i))));
    expect(f.snapshot()).toHaveLength(50);
    expect(f.snapshot()[0].id).toBe("5");
    expect(f.appendEntry).toHaveBeenCalledTimes(55);
    expect(f.appendEntry.mock.calls.every(([, data]) => !Array.isArray(data))).toBe(true);
    f.replace(Array.from({ length: 60 }, (_, i) => saved(String(i))));
    f.fire("session_tree");
    expect(f.snapshot()).toHaveLength(50);
    expect(f.snapshot()[0].id).toBe("10");
  });

  it("appends guidance without mandatory trivial-call spam", () => {
    const prompt = fixture().fire("before_agent_start", { systemPrompt: "Original" }).systemPrompt;
    expect(prompt).toMatch(/^Original\n\n/);
    for (const text of [
      "report_progress",
      "initial intent",
      "substantial",
      "milestones",
      "findings",
      "blockers",
      "verification",
      "concise",
      "secrets",
      "raw logs",
      "same parallel batch",
      "trivial",
    ]) {
      expect(prompt).toContain(text);
    }
  });
});
