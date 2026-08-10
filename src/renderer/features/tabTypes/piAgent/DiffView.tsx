/**
 * Renders edit/write tool diffs.
 *
 * Two payload shapes are supported, both captured from real `tool_execution_end` results:
 *
 * - With the `pi-diff` package loaded (this user's config):
 *   `{ _type: "editInfo" | "multiEditInfo", filePath, diff: { lines: [{type, oldNum, newNum, content}], added, removed } }`
 * - Without it (baseline pi): `{ diff: "<text>", patch: "<unified>", firstChangedLine }`
 *
 * The same package's `apply_patch` tool reports a third shape — `{ _type: "applyPatchInfo", result:
 * { applied: [{ path, action, diff, oldContent, newContent, movePath }] } }` — which previously fell
 * through to the generic card and rendered as a bare "applied N changes" line with no diff at all.
 *
 * Anything else falls back to the generic ANSI card.
 */

import { Highlight, themes } from "prism-react-renderer";
import { highlightLanguage } from "../../../lib/markdown";
import type { PiToolEntry } from "./eventReducer";

/** One file touched by an `apply_patch` call. */
interface AppliedChange {
  path: string;
  action: string;
  diff?: string;
  oldContent?: string;
  newContent?: string;
  movePath?: string;
}

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

/** A file extension is the same key markdown fences use, so the alias table is shared. */
function languageFor(filePath: string | undefined): string {
  return highlightLanguage(filePath?.split(".").pop());
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

/** Extracts the per-file changes of an `apply_patch` result, or null. */
function readApplyPatch(details: Record<string, unknown> | undefined): AppliedChange[] | null {
  if (!details || details._type !== "applyPatchInfo") return null;
  const result = details.result;
  if (!isRecord(result) || !Array.isArray(result.applied)) return null;
  const changes = result.applied.filter(isRecord).flatMap((change) => {
    if (typeof change.path !== "string") return [];
    return [
      {
        path: change.path,
        action: typeof change.action === "string" ? change.action : "update",
        diff: typeof change.diff === "string" ? change.diff : undefined,
        oldContent: typeof change.oldContent === "string" ? change.oldContent : undefined,
        newContent: typeof change.newContent === "string" ? change.newContent : undefined,
        movePath: typeof change.movePath === "string" ? change.movePath : undefined,
      },
    ];
  });
  return changes.length ? changes : null;
}

/** True when this tool result carries a diff worth rendering natively. */
export function hasDiff(entry: PiToolEntry): boolean {
  return (
    readStructuredDiff(entry.details) !== null ||
    readPatch(entry.details) !== null ||
    readApplyPatch(entry.details) !== null
  );
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

/**
 * Renders a unified patch, or any `-`/`+`/` `-prefixed diff text.
 *
 * Exported because tool *arguments* carry patch text too — `apply_patch` streams its changes long
 * before any result exists, and previewing them uses exactly this renderer.
 */
export function PatchView({ patch }: { patch: string }): JSX.Element {
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

/** The `path  +n −m` strip above a diff. */
export function DiffHeader({
  filePath,
  added,
  removed,
  note,
}: {
  filePath?: string;
  added?: number;
  removed?: number;
  note?: string;
}): JSX.Element {
  return (
    <div className="border-b border-[var(--pi-border-muted)] px-2.5 py-1 text-[11px] text-[var(--pi-muted)]">
      {filePath ? <span className="mr-2 break-all">{filePath}</span> : null}
      {added !== undefined ? <span className="text-[var(--pi-green)]">+{added}</span> : null}{" "}
      {removed !== undefined ? <span className="text-[var(--pi-red)]">−{removed}</span> : null}
      {note ? <span className="ml-2">{note}</span> : null}
    </div>
  );
}

/**
 * Renders a whole file as one solid block of additions or deletions.
 *
 * This is the right shape for a created or deleted file, where a diff against nothing would just be
 * every line marked — and for a `write` preview, where the new content is all there is to show.
 */
export function WholeFileView({
  content,
  filePath,
  type,
  maxLines = 400,
}: {
  content: string;
  filePath?: string;
  type: "add" | "del";
  maxLines?: number;
}): JSX.Element {
  const language = languageFor(filePath);
  const all = content.replace(/\n$/, "").split("\n");
  const lines = all.slice(0, maxLines);
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-relaxed">
      {lines.map((line, index) => (
        <div key={index} className={`flex ${lineClass(type)}`}>
          <span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--pi-dim)]">
            {index + 1}
          </span>
          <span className="w-3 shrink-0 select-none">{marker(type)}</span>
          <span className="whitespace-pre-wrap break-words">
            {language ? (
              <Highlight theme={themes.vsDark} code={line} language={language}>
                {({ tokens, getTokenProps }) => (
                  <>
                    {(tokens[0] ?? []).map((token, tokenIndex) => (
                      <span key={tokenIndex} {...getTokenProps({ token })} />
                    ))}
                  </>
                )}
              </Highlight>
            ) : (
              line
            )}
          </span>
        </div>
      ))}
      {all.length > lines.length ? (
        <div className="px-2 py-1 text-[11px] text-[var(--pi-dim)]">
          … {all.length - lines.length} more lines
        </div>
      ) : null}
    </div>
  );
}

/** Renders one `apply_patch` file change with whichever payload that action provides. */
function AppliedChangeView({ change }: { change: AppliedChange }): JSX.Element {
  const note =
    change.action === "move" && change.movePath
      ? `moved → ${change.movePath}`
      : change.action !== "update"
        ? change.action
        : undefined;

  let body: JSX.Element | null = null;
  if (change.diff) body = <PatchView patch={change.diff} />;
  else if (change.action === "add" && change.newContent !== undefined)
    body = <WholeFileView content={change.newContent} filePath={change.path} type="add" />;
  else if (change.action === "delete" && change.oldContent !== undefined)
    body = <WholeFileView content={change.oldContent} filePath={change.path} type="del" />;

  return (
    <div className="border-t border-[var(--pi-border-muted)] first:border-t-0">
      <DiffHeader filePath={change.path} note={note} />
      {body}
    </div>
  );
}

/** Renders the diff carried by an edit/write/apply_patch tool result. */
export function DiffView({ entry }: { entry: PiToolEntry }): JSX.Element | null {
  const structured = readStructuredDiff(entry.details);
  if (structured) {
    return (
      <div>
        <DiffHeader
          filePath={structured.filePath}
          added={structured.added}
          removed={structured.removed}
        />
        <StructuredDiffView diff={structured} />
      </div>
    );
  }

  const applied = readApplyPatch(entry.details);
  if (applied) {
    return (
      <div>
        {applied.map((change, index) => (
          <AppliedChangeView key={`${change.path}-${index}`} change={change} />
        ))}
      </div>
    );
  }

  const patch = readPatch(entry.details);
  return patch ? <PatchView patch={patch} /> : null;
}
