/** Native transcript styled after the active `reference-tool-cards` Pi theme. */

import { useMemo, useState } from "react";
import { AnsiText } from "../../../lib/ansi";
import { Markdown } from "../../../lib/markdown";
import { DiffView, hasDiff } from "./DiffView";
import type { PiEntry, PiMessageEntry, PiToolEntry } from "./eventReducer";
import { readableArgs } from "./partialJson";
import { resolveToolView } from "./toolViews";

const COLLAPSED_LINES = 8;

/** Formats tool timing in the same compact form as the TUI extension. */
function formatDuration(entry: PiToolEntry): string | null {
  if (entry.endedAt === undefined) return null;
  const ms = Math.max(0, entry.endedAt - entry.startedAt);
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/** Returns the theme color used for the reasoning level that launched a tool. */
function reasoningColor(entry: PiToolEntry): string {
  switch (entry.reasoningLevel) {
    case "off":
      return "var(--pi-dim)";
    case "minimal":
      return "var(--pi-muted)";
    case "low":
      return "var(--pi-blue)";
    case "medium":
      return "var(--pi-cyan)";
    case "xhigh":
      return "#d879ff";
    case "max":
      return "#f472b6";
    default:
      return "var(--pi-purple)";
  }
}

/** Summarises the most useful argument, used as the card's hover title. */
function argSummary(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "action"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Header line for a tool whose view supplies no label of its own. */
function fallbackLabel(entry: PiToolEntry, args: Record<string, unknown> | undefined): string {
  const summary = argSummary(args);
  return summary ? `${entry.toolName}  ${summary}` : entry.toolName;
}

function statusLabel(entry: PiToolEntry): string {
  if (entry.phase === "generating") return "◌ Preparing";
  if (entry.phase === "ready") return "◌ Ready";
  if (entry.endedAt === undefined) return "● Running";
  return entry.isError ? "✕ Failed" : "✓ Completed";
}

interface ToolBodyProps {
  entry: PiToolEntry;
}

/**
 * The card body: an argument-driven preview that fills in live, superseded by the tool's own diff
 * once it returns one, plus the output stream.
 */
function ToolBody({ entry }: ToolBodyProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = entry.output ? entry.output.replace(/\n$/, "").split("\n") : [];
  const hidden = Math.max(0, lines.length - COLLAPSED_LINES);
  const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
  const diff = hasDiff(entry);

  const view = resolveToolView(entry.toolName);
  // A delta re-renders the whole transcript, so without this every open card would re-parse its
  // buffer on every token of every other card.
  const args = useMemo(
    () => readableArgs(entry),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these two fields are the whole input
    [entry.args, entry.partialArgs],
  );
  const streaming = entry.phase === "generating";
  const Preview = view.Preview;
  const preview =
    !diff && Preview && args ? <Preview args={args} entry={entry} streaming={streaming} /> : null;
  const label = (args && view.label?.(args, entry)) || fallbackLabel(entry, args);

  // Once a preview or diff is on screen, the tool's textual summary is redundant noise; keep the
  // output block for tools that actually stream something worth reading.
  const showOutput = !diff && (lines.length > 0 || (!preview && !streaming));
  // Nothing parsed out of the buffer yet — show the raw bytes rather than an empty card.
  const showRawArgs = streaming && !preview && !diff;

  const stateClass = entry.isError ? " is-error" : entry.endedAt === undefined ? " is-running" : "";

  return (
    <div className={`pi-tool-inner${stateClass}`}>
      <div className="pi-tool-call" title={argSummary(args)}>
        {label}
        {streaming ? <span className="pi-streaming-cursor">▍</span> : null}
      </div>
      {diff ? <DiffView entry={entry} /> : null}
      {preview ? (
        <div className={entry.phase === "completed" ? undefined : "pi-tool-preview"}>{preview}</div>
      ) : null}
      {showRawArgs ? (
        <pre className="pi-tool-output whitespace-pre-wrap break-all">
          {entry.partialArgs || "Building arguments…"}
        </pre>
      ) : null}
      {showOutput ? (
        <pre className="pi-tool-output">
          {shown.length ? (
            <AnsiText text={shown.join("\n")} />
          ) : (
            <span className="pi-dim">Waiting for output…</span>
          )}
        </pre>
      ) : null}
      {!diff && hidden > 0 ? (
        <button
          type="button"
          className="pi-tool-expand"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "▴ collapse"
            : `… ${hidden} more line${hidden === 1 ? "" : "s"} · click to expand`}
        </button>
      ) : null}
    </div>
  );
}

function ToolSection({
  entry,
  showHeader = true,
}: {
  entry: PiToolEntry;
  showHeader?: boolean;
}): JSX.Element {
  const duration = formatDuration(entry);
  const color = entry.isError ? "var(--pi-red)" : reasoningColor(entry);
  return (
    <div className="pi-tool-section" style={{ "--pi-card-accent": color } as React.CSSProperties}>
      {showHeader ? (
        <div className="pi-tool-rule">
          <span className="pi-tool-rule-line" />
          {typeof entry.args?.timeout === "number" ? (
            <span>◷ timeout {entry.args.timeout}s</span>
          ) : null}
          {entry.parallelGroup ? <span>⇉ Parallel</span> : null}
          {entry.reviewStatus ? <AnsiText text={entry.reviewStatus} /> : null}
          <span>{statusLabel(entry)}</span>
        </div>
      ) : null}
      <ToolBody entry={entry} />
      <div className="pi-tool-duration">
        ◷ {duration ? `Took ${duration}` : entry.endedAt ? "Timing unavailable" : "In progress"}
      </div>
    </div>
  );
}

function ToolCard({ entry }: { entry: PiToolEntry }): JSX.Element {
  const color = entry.isError ? "var(--pi-red)" : reasoningColor(entry);
  return (
    <div
      className="pi-tool-card pi-single-tool-card"
      style={{ "--pi-card-accent": color } as React.CSSProperties}
    >
      <div className="pi-tool-border-status">
        {typeof entry.args?.timeout === "number" ? (
          <span>◷ timeout {entry.args.timeout}s</span>
        ) : null}
        {entry.reviewStatus ? <AnsiText text={entry.reviewStatus} /> : null}
        <span>{statusLabel(entry)}</span>
      </div>
      <ToolSection entry={entry} showHeader={false} />
    </div>
  );
}

function ParallelToolGroup({ entries }: { entries: PiToolEntry[] }): JSX.Element {
  const running = entries.some((entry) => entry.endedAt === undefined);
  const failed = entries.some((entry) => entry.isError);
  const color = failed ? "var(--pi-red)" : reasoningColor(entries[0]);
  const reviewStatuses = [
    ...new Set(entries.map((entry) => entry.reviewStatus).filter(Boolean)),
  ] as string[];
  return (
    <div
      className="pi-tool-card pi-parallel-group"
      style={{ "--pi-card-accent": color } as React.CSSProperties}
    >
      <div className="pi-tool-border-status">
        <span>⇉ Parallel</span>
        {reviewStatuses.map((status) => (
          <AnsiText key={status} text={status} />
        ))}
        <span>{running ? "● Running" : failed ? "✕ Failed" : "✓ Completed"}</span>
      </div>
      {entries.map((entry, index) => (
        <ToolSection key={entry.id} entry={entry} showHeader={index > 0} />
      ))}
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="pi-thinking">
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? "▴ thinking" : "▾ thinking"}
      </button>
      {open ? <pre>{text}</pre> : null}
    </div>
  );
}

function Message({ entry }: { entry: PiMessageEntry }): JSX.Element {
  const isUser = entry.role === "user";
  return (
    <div className={isUser ? "pi-message pi-user-message" : "pi-message pi-assistant-message"}>
      {entry.thinking ? <ThinkingBlock text={entry.thinking} /> : null}
      {entry.text ? (
        <div className="break-words">
          {isUser ? (
            <div className="whitespace-pre-wrap">{entry.text}</div>
          ) : (
            <Markdown text={entry.text} />
          )}
          {entry.streaming ? <span className="pi-streaming-cursor">▍</span> : null}
        </div>
      ) : null}
      {entry.error ? (
        <div className="whitespace-pre-wrap break-words text-[var(--pi-red)]">{entry.error}</div>
      ) : null}
    </div>
  );
}

/** Renders messages and coalesces adjacent sibling tool calls into one parallel card. */
export function Transcript({
  entries,
  working = false,
  operationStatus,
}: {
  entries: PiEntry[];
  working?: boolean;
  operationStatus?: string;
}): JSX.Element {
  const rendered: JSX.Element[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === "message") {
      if (entry.text || entry.thinking || entry.error)
        rendered.push(<Message key={entry.id} entry={entry} />);
      continue;
    }

    const groupId = entry.parallelGroup?.id;
    if (!groupId) {
      rendered.push(<ToolCard key={entry.id} entry={entry} />);
      continue;
    }

    const group: PiToolEntry[] = [entry];
    while (true) {
      const next = entries[index + 1];
      if (next?.kind !== "tool" || next.parallelGroup?.id !== groupId) break;
      group.push(next);
      index += 1;
    }
    rendered.push(<ParallelToolGroup key={groupId} entries={group} />);
  }

  return (
    <div className="pi-transcript">
      {rendered}
      {working || operationStatus ? (
        <div className="text-[var(--pi-dim)]">{operationStatus ?? "working…"}</div>
      ) : null}
    </div>
  );
}
