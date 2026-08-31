import { describe, expect, it } from "vitest";
import type { PiToolEntry } from "./eventReducer";
import { parsePartialJson } from "./partialJson";
import { inferToolName, resolveToolView } from "./toolViews";
import { coveringDependencies } from "./TodoWebPreview";
import { pathHits, routeOrthogonal } from "./todoWebRoute";

function entry(toolName: string): PiToolEntry {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "t1",
    toolName,
    output: "",
    phase: "generating",
    startedAt: 0,
    isError: false,
  };
}

/** Runs a tool's header through the same path the card uses: partial JSON in, label out. */
function labelFor(toolName: string, partialArgs: string): string | null | undefined {
  const view = resolveToolView(toolName);
  const args = parsePartialJson(partialArgs);
  return args ? view.label?.(args, entry(toolName)) : undefined;
}

describe("resolveToolView", () => {
  it("infers edit tools from arguments when the provider streams no name", () => {
    expect(inferToolName("tool", { path: "a.ts", edits: [] })).toBe("edit");
    expect(inferToolName("tool", { changes: [] })).toBe("apply_patch");
    expect(inferToolName("tool", { query: "leave generic" })).toBe("tool");
  });

  it("falls back to the generic field view for unknown tools", () => {
    const view = resolveToolView("some_future_extension_tool");
    expect(view.Preview).toBeDefined();
    expect(view.label).toBeUndefined();
  });

  it("gives known tools a dedicated preview", () => {
    for (const name of [
      "edit",
      "write",
      "apply_patch",
      "parallel_agents",
      "ask_user_questions",
      "todo_web",
    ]) {
      expect(resolveToolView(name).Preview).toBeDefined();
    }
  });
});

describe("tool labels from streaming arguments", () => {
  it("shows a bash command as it is typed", () => {
    expect(labelFor("bash", '{"command":"npm run bu')).toBe("$ npm run bu");
    expect(labelFor("bash", '{"command":"npm run build"}')).toBe("$ npm run build");
  });

  it("collapses a multi-line bash script to one header line", () => {
    expect(labelFor("bash", '{"command":"cd x\\nnpm test"}')).toBe("$ cd x npm test");
  });

  it("labels a read with its range once the numbers arrive", () => {
    expect(labelFor("read", '{"path":"a.ts"}')).toBe("→ Read a.ts");
    expect(labelFor("read", '{"path":"a.ts","offset":10,"limit":40}')).toBe("→ Read a.ts (10+40)");
  });

  it("counts apply_patch changes and names the files", () => {
    expect(labelFor("apply_patch", '{"changes":[')).toBe("⇄ apply_patch");
    expect(
      labelFor("apply_patch", '{"changes":[{"path":"src/a.ts","action":"update","oldText":"x'),
    ).toBe("⇄ apply_patch (1 change) · a.ts");
    expect(
      labelFor(
        "apply_patch",
        '{"changes":[{"path":"src/a.ts","action":"update"},{"path":"src/b.ts","action":"add"',
      ),
    ).toBe("⇄ apply_patch (2 changes) · a.ts, b.ts");
  });

  it("counts sub-agents as their tasks stream in", () => {
    expect(labelFor("parallel_agents", '{"tasks":[{"model":"x","prompt":"do')).toBe(
      "⇉ 1 sub-agent",
    );
    expect(labelFor("parallel_agents", '{"tasks":[{"model":"x"},{"model":"y"},{"model":"z"}')).toBe(
      "⇉ 3 sub-agents",
    );
  });

  it("labels edit and write by path, tolerating naming variants", () => {
    expect(labelFor("edit", '{"path":"a.ts","edits":[')).toBe("✎ Edit a.ts");
    expect(labelFor("write", '{"file_path":"a.ts","content":"x')).toBe("✎ Write a.ts");
    expect(labelFor("edit", "{")).toBe("✎ Edit");
  });

  it("labels grep with its pattern and scope", () => {
    expect(labelFor("grep", '{"pattern":"TODO","path":"src"}')).toBe("⌕ Grep TODO in src");
    expect(labelFor("grep", '{"pattern":"TODO"}')).toBe("⌕ Grep TODO");
  });

  it("labels search tools by query regardless of which package provides them", () => {
    expect(labelFor("brave_llm_search", '{"query":"rust tokio"}')).toBe("⌕ rust tokio");
    expect(labelFor("exa_web_search", '{"query":"rust tokio"}')).toBe("⌕ rust tokio");
  });

  it("counts questions for ask_user_questions", () => {
    expect(labelFor("ask_user_questions", '{"questions":[{"question":"Which one?"')).toBe(
      "? 1 question",
    );
  });

  it("truncates an overlong header rather than letting it wrap forever", () => {
    const long = "x".repeat(500);
    const label = labelFor("bash", JSON.stringify({ command: long }));
    expect(label).toHaveLength(122); // "$ " + 120
    expect(label?.endsWith("…")).toBe(true);
  });

  it("labels todo_web with action, counts and title", () => {
    expect(labelFor("todo_web", '{"action":"set"')).toBe("☑ Todo set");
    expect(
      labelFor(
        "todo_web",
        '{"action":"set","web":{"title":"Live cards","tasks":[{"id":"a","status":"completed"},{"id":"b"}]}}',
      ),
    ).toBe("☑ Todo set · 1/2 · Live cards");
  });
});

describe("todo-web covering dependencies", () => {
  it("drops edges that are already implied by a longer path", () => {
    const covering = coveringDependencies([
      { id: "data-api", dependencies: [] },
      { id: "imports", dependencies: ["data-api"] },
      { id: "frontend", dependencies: ["data-api", "imports"] },
      { id: "gmail", dependencies: ["imports"] },
      { id: "verify", dependencies: ["data-api", "imports", "frontend", "gmail"] },
    ]);
    expect(covering.get("data-api")).toEqual([]);
    expect(covering.get("imports")).toEqual(["data-api"]);
    expect(covering.get("frontend")).toEqual(["imports"]);
    expect(covering.get("gmail")).toEqual(["imports"]);
    expect(covering.get("verify")).toEqual(["frontend", "gmail"]);
  });

  it("keeps independent parallel blockers", () => {
    const covering = coveringDependencies([
      { id: "a", dependencies: [] },
      { id: "b", dependencies: [] },
      { id: "c", dependencies: ["a", "b"] },
    ]);
    expect(covering.get("c")).toEqual(["a", "b"]);
  });
});

describe("todo-web orthogonal routing", () => {
  it("takes a straight line when nothing is in the way", () => {
    const path = routeOrthogonal({ x: 10, y: 40 }, { x: 90, y: 40 }, [], { w: 120, h: 80 });
    expect(pathHits(path, [])).toBe(false);
    expect(length(path)).toBe(80);
  });

  it("goes around a blocking card on the shortest detour", () => {
    const wall = { id: "mid", x: 40, y: 20, w: 40, h: 40 };
    const path = routeOrthogonal({ x: 10, y: 40 }, { x: 120, y: 40 }, [wall], { w: 160, h: 100 });
    expect(pathHits(path, [wall])).toBe(false);
    const manhattan = 110;
    const aroundFar = 110 + 2 * 40;
    expect(length(path)).toBeGreaterThan(manhattan);
    expect(length(path)).toBeLessThanOrEqual(aroundFar);
  });

  it("uses a separate lane instead of overlapping an existing route", () => {
    const first = routeOrthogonal({ x: 10, y: 40 }, { x: 120, y: 40 }, [], { w: 160, h: 100 });
    const second = routeOrthogonal({ x: 10, y: 40 }, { x: 120, y: 40 }, [], { w: 160, h: 100 }, [
      first,
    ]);

    expect(second).not.toEqual(first);
    expect(second.length).toBeGreaterThan(2);
  });
});

function length(points: { x: number; y: number }[]): number {
  return points
    .slice(1)
    .reduce(
      (sum, point, index) =>
        sum + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y),
      0,
    );
}
