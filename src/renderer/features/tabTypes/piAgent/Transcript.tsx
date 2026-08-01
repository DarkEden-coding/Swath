/**
 * Conversation transcript: user/assistant messages, collapsible thinking, and tool cards.
 *
 * Tool cards reproduce the TUI's `tool-cards.ts` layout (name, status, duration, bordered body)
 * with click-to-expand replacing `ctrl+o`, since that extension's renderer is TUI-only.
 */

import { useState } from "react";
import { AnsiText } from "../../../lib/ansi";
import { Markdown } from "../../../lib/markdown";
import { DiffView, hasDiff } from "./DiffView";
import type { PiEntry, PiMessageEntry, PiToolEntry } from "./eventReducer";

/** Lines shown before a tool card collapses its output. */
const COLLAPSED_LINES = 8;

function formatDuration(entry: PiToolEntry): string | null {
  if (entry.endedAt === undefined) return null;
  const ms = entry.endedAt - entry.startedAt;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Summarises tool arguments the way the TUI header does (command, path, or nothing). */
function argSummary(entry: PiToolEntry): string {
  const args = entry.args;
  if (!args) return "";
  for (const key of ["command", "path", "file_path", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function ToolCard({ entry }: { entry: PiToolEntry }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = entry.output ? entry.output.replace(/\n$/, "").split("\n") : [];
  const hidden = Math.max(0, lines.length - COLLAPSED_LINES);
  const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const duration = formatDuration(entry);
  const running = entry.endedAt === undefined;
  const summary = argSummary(entry);
  const diff = hasDiff(entry);

  const border = entry.isError
    ? "border-[#f14c4c]"
    : running
      ? "border-swath-accent"
      : "border-swath-border";

  return (
    <div className={`my-2 rounded border ${border} bg-[#0d1117]`}>
      <div className="flex items-center gap-2 border-b border-swath-border px-2.5 py-1 font-mono text-[11px]">
        <span className="font-semibold text-swath-text">{entry.toolName}</span>
        {summary ? (
          <span className="truncate text-swath-muted" title={summary}>
            {summary}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-swath-muted">
          {running ? "running…" : entry.isError ? "✗ Failed" : "✓ Completed"}
          {duration ? ` · ${duration}` : ""}
        </span>
      </div>

      {diff ? <DiffView entry={entry} /> : null}

      {!diff && shown.length > 0 ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-swath-text">
          <AnsiText text={shown.join("\n")} />
        </pre>
      ) : null}

      {!diff && hidden > 0 ? (
        <button
          type="button"
          className="w-full border-t border-swath-border px-2.5 py-1 text-left font-mono text-[11px] text-swath-muted hover:text-swath-text"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "▴ collapse" : `▾ ${hidden} more line${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        className="font-mono text-[11px] text-swath-muted hover:text-swath-text"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "▴ thinking" : "▾ thinking"}
      </button>
      {open ? (
        <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-swath-border pl-3 font-mono text-[12px] italic text-swath-muted">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function Message({ entry }: { entry: PiMessageEntry }): JSX.Element {
  const isUser = entry.role === "user";
  return (
    <div className={`my-2 ${isUser ? "border-l-2 border-swath-accent pl-3" : ""}`}>
      {entry.thinking ? <ThinkingBlock text={entry.thinking} /> : null}
      {entry.text ? (
        <div className="break-words">
          {isUser ? (
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-swath-text">
              {entry.text}
            </div>
          ) : (
            <Markdown text={entry.text} />
          )}
          {entry.streaming ? <span className="ml-0.5 animate-pulse">▍</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Transcript({ entries }: { entries: PiEntry[] }): JSX.Element {
  return (
    <div className="px-3 py-2">
      {entries.map((entry) =>
        entry.kind === "tool" ? (
          <ToolCard key={entry.id} entry={entry} />
        ) : (
          <Message key={entry.id} entry={entry} />
        ),
      )}
    </div>
  );
}
