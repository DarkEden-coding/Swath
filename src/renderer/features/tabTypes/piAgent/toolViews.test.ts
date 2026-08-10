import { describe, expect, it } from "vitest";
import type { PiToolEntry } from "./eventReducer";
import { parsePartialJson } from "./partialJson";
import { resolveToolView } from "./toolViews";

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
  it("falls back to the generic field view for unknown tools", () => {
    const view = resolveToolView("some_future_extension_tool");
    expect(view.Preview).toBeDefined();
    expect(view.label).toBeUndefined();
  });

  it("gives known tools a dedicated preview", () => {
    for (const name of ["edit", "write", "apply_patch", "parallel_agents", "ask_user_questions"]) {
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
});
