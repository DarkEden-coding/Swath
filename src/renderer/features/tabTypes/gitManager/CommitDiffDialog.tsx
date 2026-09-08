import { Highlight, themes } from "prism-react-renderer";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { highlightLanguage } from "../../../lib/markdown";
import { gitClient, type GitLogEntry } from "../../../services/gitClient";
import { IconClose } from "../../shell/icons";

export interface CommitDiffLine {
  type: "add" | "delete" | "context" | "note";
  content: string;
  oldNumber: number | null;
  newNumber: number | null;
}

export interface CommitDiffHunk {
  range: string;
  heading: string;
  skippedBefore: number;
  lines: CommitDiffLine[];
}

export interface CommitDiffFile {
  path: string;
  oldPath: string;
  newPath: string;
  metadata: string[];
  hunks: CommitDiffHunk[];
  added: number;
  removed: number;
}

export type GitDiffTarget =
  { kind: "commit"; commit: GitLogEntry } | { kind: "staged" | "unstaged"; path: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/;

function displayPath(raw: string): string {
  const path = raw.trim().replace(/^"|"$/g, "");
  return path === "/dev/null" ? path : path.replace(/^[ab]\//, "");
}

/** Parses Git's unified patch into files, separated edit regions, and numbered lines. */
export function parseCommitPatch(patch: string): CommitDiffFile[] {
  const files: CommitDiffFile[] = [];
  let file: CommitDiffFile | null = null;
  let hunk: CommitDiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  let previousOldEnd: number | null = null;

  for (const line of patch.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const newPathMarker = line.lastIndexOf(" b/");
      file = {
        path: newPathMarker >= 0 ? displayPath(line.slice(newPathMarker + 1)) : "",
        oldPath: "",
        newPath: "",
        metadata: [],
        hunks: [],
        added: 0,
        removed: 0,
      };
      files.push(file);
      hunk = null;
      previousOldEnd = null;
      continue;
    }
    if (!file) continue;
    if (!hunk && line.startsWith("--- ")) {
      file.oldPath = displayPath(line.slice(4));
      continue;
    }
    if (!hunk && line.startsWith("+++ ")) {
      file.newPath = displayPath(line.slice(4));
      file.path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      hunk = {
        range: `−${header[1]}${header[2] === undefined ? "" : `,${header[2]}`} +${header[3]}${header[4] === undefined ? "" : `,${header[4]}`}`,
        heading: header[5],
        skippedBefore: previousOldEnd === null ? 0 : Math.max(0, oldStart - previousOldEnd),
        lines: [],
      };
      file.hunks.push(hunk);
      oldNumber = oldStart;
      newNumber = newStart;
      previousOldEnd = oldStart + oldCount;
      continue;
    }

    if (!hunk) {
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        file.oldPath = displayPath(line.slice(line.indexOf(" from ") + 6));
      } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        file.newPath = displayPath(line.slice(line.indexOf(" to ") + 4));
        file.path = file.newPath;
      } else {
        const binary = /^Binary files (.+) and (.+) differ$/.exec(line);
        if (binary) {
          file.oldPath = displayPath(binary[1]);
          file.newPath = displayPath(binary[2]);
          file.path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
        }
      }
      if (line && !line.startsWith("index ")) file.metadata.push(line);
      continue;
    }

    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", content: line.slice(1), oldNumber: null, newNumber });
      file.added += 1;
      newNumber += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "delete", content: line.slice(1), oldNumber, newNumber: null });
      file.removed += 1;
      oldNumber += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({
        type: "context",
        content: line.slice(1),
        oldNumber,
        newNumber,
      });
      oldNumber += 1;
      newNumber += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "note", content: line, oldNumber: null, newNumber: null });
    }
  }

  for (const parsed of files) {
    if (!parsed.path) parsed.path = parsed.newPath || parsed.oldPath || "Changed file";
  }
  return files;
}

function lineStyle(type: CommitDiffLine["type"]): string {
  if (type === "add") return "bg-[#12261a] text-swath-good";
  if (type === "delete") return "bg-[#2b1417] text-swath-danger";
  if (type === "note") return "bg-swath-panel-2 text-swath-muted";
  return "text-swath-text";
}

function marker(type: CommitDiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "delete") return "−";
  return " ";
}

/** Renders one syntax-highlighted source line with old and new line-number gutters. */
function DiffLine({ line, language }: { line: CommitDiffLine; language: string }): JSX.Element {
  return (
    <div className={`flex min-w-max ${lineStyle(line.type)}`}>
      <span className="w-12 shrink-0 select-none border-r border-swath-border/30 pr-2 text-right text-swath-muted-2">
        {line.oldNumber ?? ""}
      </span>
      <span className="w-12 shrink-0 select-none border-r border-swath-border/30 pr-2 text-right text-swath-muted-2">
        {line.newNumber ?? ""}
      </span>
      <span className="w-7 shrink-0 select-none text-center">{marker(line.type)}</span>
      <span className="whitespace-pre pr-4">
        {language && line.type !== "note" ? (
          <Highlight theme={themes.vsDark} code={line.content} language={language}>
            {({ tokens, getTokenProps }) => (
              <>
                {(tokens[0] ?? []).map((token, index) => (
                  <span key={index} {...getTokenProps({ token })} />
                ))}
              </>
            )}
          </Highlight>
        ) : (
          line.content
        )}
      </span>
    </div>
  );
}

/** Renders the files and edit regions in a parsed commit patch. */
function CommitPatch({ files }: { files: CommitDiffFile[] }): JSX.Element {
  if (files.length === 0) {
    return <p className="p-8 text-center text-swath-muted">This commit has no file changes.</p>;
  }

  return (
    <div className="space-y-4 p-4">
      {files.map((file, fileIndex) => {
        const language = highlightLanguage(file.path.split(".").pop());
        return (
          <section
            key={`${file.path}-${fileIndex}`}
            className="overflow-hidden rounded-lg border border-swath-border bg-swath-bg shadow-inner"
          >
            <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-swath-border bg-swath-panel px-3 py-2">
              <span className="min-w-0 flex-1 break-all font-mono text-[12px] font-semibold text-swath-text">
                {file.path}
              </span>
              <span className="font-mono text-[11px] text-swath-good">+{file.added}</span>
              <span className="font-mono text-[11px] text-swath-danger">−{file.removed}</span>
            </header>
            {file.metadata.length > 0 ? (
              <div className="border-b border-swath-border/60 bg-swath-panel-2/60 px-3 py-1.5 font-mono text-[11px] text-swath-muted">
                {file.metadata.map((line, index) => (
                  <div key={index}>{line}</div>
                ))}
              </div>
            ) : null}
            {file.hunks.map((hunk, hunkIndex) => (
              <div key={hunkIndex} className="font-mono text-[12px] leading-5">
                {hunk.skippedBefore > 0 ? (
                  <div className="flex items-center gap-3 bg-swath-panel-2/70 px-3 py-1 text-[11px] text-swath-muted">
                    <span className="h-px flex-1 bg-swath-border" />
                    <span>{hunk.skippedBefore} unchanged lines</span>
                    <span className="h-px flex-1 bg-swath-border" />
                  </div>
                ) : null}
                <div className="flex gap-3 border-y border-swath-accent/20 bg-swath-accent/10 px-3 py-1 text-[11px] text-swath-accent-strong">
                  <span className="shrink-0">{hunk.range}</span>
                  <span className="truncate text-swath-muted">
                    {hunk.heading || "Changed region"}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  {hunk.lines.map((line, lineIndex) => (
                    <DiffLine key={lineIndex} line={line} language={language} />
                  ))}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** Loads and presents a committed, staged, or working-tree diff. */
export function GitDiffDialog({
  cwd,
  target,
  onClose,
}: {
  cwd: string;
  target: GitDiffTarget;
  onClose(): void;
}): JSX.Element {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const files = useMemo(() => (patch === null ? [] : parseCommitPatch(patch)), [patch]);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const commit = target.kind === "commit" ? target.commit : null;
  const title = target.kind === "commit" ? target.commit.subject : target.path;
  const badge =
    target.kind === "commit"
      ? target.commit.short
      : target.kind === "staged"
        ? "STAGED"
        : "WORKING TREE";

  useEffect(() => {
    let active = true;
    const request =
      target.kind === "commit"
        ? gitClient.getCommitDiff(cwd, target.commit.hash)
        : gitClient.getWorkingDiff(cwd, target.path, target.kind === "staged");
    void request.then((result) => {
      if (!active) return;
      if (result.ok) setPatch(result.patch);
      else setError(result.error ?? result.stderr ?? "Unable to load diff");
    });
    return () => {
      active = false;
    };
  }, [cwd, target]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-[rgba(5,7,10,.76)] p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-diff-title"
        className="flex max-h-[92vh] w-[min(1100px,96vw)] flex-col overflow-hidden rounded-xl border border-swath-border-strong bg-swath-panel shadow-swath-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-swath-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <h2
                id="git-diff-title"
                className="truncate text-[14px] font-semibold text-swath-text"
              >
                {title}
              </h2>
              <code className="shrink-0 rounded bg-swath-panel-2 px-1.5 py-0.5 text-[10px] text-swath-accent-strong">
                {badge}
              </code>
            </div>
            <div className="flex flex-wrap gap-x-3 text-[11px] text-swath-muted">
              {commit ? <span>{commit.author}</span> : <span>Uncommitted changes</span>}
              {commit ? <span>{commit.date}</span> : null}
              {patch !== null ? <span>{files.length} changed files</span> : null}
              {patch !== null ? <span className="text-swath-good">+{added}</span> : null}
              {patch !== null ? <span className="text-swath-danger">−{removed}</span> : null}
            </div>
          </div>
          <button
            type="button"
            autoFocus
            className="grid size-8 shrink-0 place-items-center rounded-md text-swath-muted hover:bg-swath-panel-2 hover:text-swath-text"
            aria-label="Close diff"
            onClick={onClose}
          >
            <IconClose width={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-swath-bg/60">
          {error ? (
            <p className="p-6 text-swath-danger">{error}</p>
          ) : patch === null ? (
            <p className="p-8 text-center text-swath-muted">Loading diff…</p>
          ) : (
            <CommitPatch files={files} />
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
