/**
 * Renders edit/write tool diffs.
 *
 * Two payload shapes are supported, both captured from real `tool_execution_end` results:
 *
 * - With the `pi-diff` package loaded (this user's config):
 *   `{ _type: "editInfo" | "multiEditInfo", filePath, diff: { lines: [{type, oldNum, newNum, content}], added, removed } }`
 * - Without it (baseline pi): `{ diff: "<text>", patch: "<unified>", firstChangedLine }`
 *
 * Anything else falls back to the generic ANSI card.
 */

import { Highlight, themes } from "prism-react-renderer";
import type { PiToolEntry } from "./eventReducer";

interface DiffLine {
  type: "add" | "del" | "ctx" | "sep";
  content: string;
  oldNum?: number | null;
  newNum?: number | null;
}

interface StructuredDiff {
  filePath?: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  sh: "bash",
  json: "json",
  css: "css",
  html: "markup",
  md: "markdown",
  go: "go",
  sql: "sql",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
};

function languageFor(filePath: string | undefined): string {
  const ext = filePath?.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extracts a structured diff from tool details, or null when there isn't one. */
function readStructuredDiff(details: Record<string, unknown> | undefined): StructuredDiff | null {
  if (!details) return null;
  const diff = details.diff;
  if (!isRecord(diff) || !Array.isArray(diff.lines)) return null;
  const lines = diff.lines.filter(isRecord).map((line) => ({
    type: (line.type as DiffLine["type"]) ?? "ctx",
    content: typeof line.content === "string" ? line.content : "",
    oldNum: typeof line.oldNum === "number" ? line.oldNum : null,
    newNum: typeof line.newNum === "number" ? line.newNum : null,
  }));
  return {
    filePath: typeof details.filePath === "string" ? details.filePath : undefined,
    lines,
    added: typeof diff.added === "number" ? diff.added : 0,
    removed: typeof diff.removed === "number" ? diff.removed : 0,
  };
}

/** Extracts a plain unified patch from tool details, or null. */
function readPatch(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  if (typeof details.patch === "string" && details.patch.trim()) return details.patch;
  if (typeof details.diff === "string" && details.diff.trim()) return details.diff;
  return null;
}

/** True when this tool result carries a diff worth rendering natively. */
export function hasDiff(entry: PiToolEntry): boolean {
  return readStructuredDiff(entry.details) !== null || readPatch(entry.details) !== null;
}

function lineClass(type: DiffLine["type"]): string {
  if (type === "add") return "bg-[#12261a] text-[var(--pi-green)]";
  if (type === "del") return "bg-[#2b1417] text-[var(--pi-red)]";
  if (type === "sep") return "bg-black/40 text-[var(--pi-muted)]";
  return "text-[var(--pi-text)]";
}

function gutter(line: DiffLine): string {
  if (line.type === "sep") return "";
  const num = line.type === "del" ? line.oldNum : line.newNum;
  return num === null || num === undefined ? "" : String(num);
}

function marker(type: DiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "del") return "-";
  if (type === "sep") return "⋯";
  return " ";
}

function StructuredDiffView({ diff }: { diff: StructuredDiff }): JSX.Element {
  const language = languageFor(diff.filePath);

  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-relaxed">
      {diff.lines.map((line, index) => (
        <div key={index} className={`flex ${lineClass(line.type)}`}>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--pi-dim)]">
            {gutter(line)}
          </span>
          <span className="w-3 shrink-0 select-none">{marker(line.type)}</span>
          <span className="whitespace-pre-wrap break-words">
            {language && line.type !== "sep" ? (
              <Highlight theme={themes.vsDark} code={line.content} language={language}>
                {({ tokens, getTokenProps }) => (
                  <>
                    {(tokens[0] ?? []).map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                  </>
                )}
              </Highlight>
            ) : (
              line.content
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function PatchView({ patch }: { patch: string }): JSX.Element {
  const lines = patch.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-relaxed">
      {lines.map((line, index) => {
        const type: DiffLine["type"] = line.startsWith("+")
          ? "add"
          : line.startsWith("-")
            ? "del"
            : line.startsWith("@@")
              ? "sep"
              : "ctx";
        return (
          <div key={index} className={`whitespace-pre-wrap break-words px-2 ${lineClass(type)}`}>
            {line}
          </div>
        );
      })}
    </div>
  );
}

/** Renders the diff carried by an edit/write tool result. */
export function DiffView({ entry }: { entry: PiToolEntry }): JSX.Element | null {
  const structured = readStructuredDiff(entry.details);
  if (structured) {
    return (
      <div>
        <div className="border-b border-[var(--pi-border-muted)] px-2.5 py-1 text-[11px] text-[var(--pi-muted)]">
          {structured.filePath ? <span className="mr-2">{structured.filePath}</span> : null}
          <span className="text-[var(--pi-green)]">+{structured.added}</span>{" "}
          <span className="text-[var(--pi-red)]">−{structured.removed}</span>
        </div>
        <StructuredDiffView diff={structured} />
      </div>
    );
  }

  const patch = readPatch(entry.details);
  return patch ? <PatchView patch={patch} /> : null;
}
