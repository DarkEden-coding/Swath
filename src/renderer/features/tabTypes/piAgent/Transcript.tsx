/** Native transcript styled after the active `reference-tool-cards` Pi theme. */

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AnsiText } from "../../../lib/ansi";
import { Markdown } from "../../../lib/markdown";
import { DiffView, hasDiff } from "./DiffView";
import type { PiEntry, PiMessageEntry, PiToolEntry } from "./eventReducer";
import { LiveFileDiffPreview } from "./LiveFileDiffPreview";
import { readableArgs } from "./partialJson";
import { inferToolName, resolveToolView } from "./toolViews";

const COLLAPSED_LINES = 8;

/** How far outside the viewport a row is kept mounted, in CSS pixels. */
const OVERSCAN_PX = 1200;
/** Height assumed for a row that has never been measured. */
const ESTIMATED_ROW_PX = 140;
/**
 * Rows at the end of the transcript that stay mounted regardless of the observer.
 *
 * `IntersectionObserver` reports asynchronously, so a row appended mid-stream would flash as a
 * placeholder for a frame and fight the follow-to-bottom writer. The tail is where new content
 * always lands, so keeping it mounted costs nothing and removes the flicker.
 */
const TAIL_ROWS = 8;

/**
 * Disclosure state for rows that may be unmounted while scrolled away.
 *
 * Virtualisation throws away a row's component state, so an expanded output block or an open
 * thinking section would silently collapse the moment it left the window. The flags live in a map
 * owned by the transcript instead, keyed by entry.
 */
const DisclosureContext = createContext<Map<string, boolean> | null>(null);

function useDisclosure(key: string): [boolean, () => void] {
  const store = useContext(DisclosureContext);
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const open = store?.get(key) ?? false;
  const toggle = useCallback(() => {
    store?.set(key, !(store.get(key) ?? false));
    bump();
  }, [store, key]);
  return [open, toggle];
}

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

/**
 * Splits out the first `COLLAPSED_LINES` of a tool's output without materialising the rest.
 *
 * A collapsed card shows eight lines, so slicing the whole buffer into an array only to discard it
 * wastes both time and memory on the tools that produce megabytes of output.
 */
export function collapseOutput(
  output: string,
  expanded: boolean,
): { text: string; hidden: number; empty: boolean } {
  const trimmed = output.replace(/\n$/, "");
  if (!trimmed) return { text: "", hidden: 0, empty: output.length === 0 };
  if (expanded) return { text: trimmed, hidden: 0, empty: false };

  let cut = -1;
  for (let line = 0; line < COLLAPSED_LINES; line += 1) {
    const next = trimmed.indexOf("\n", cut + 1);
    if (next === -1) return { text: trimmed, hidden: 0, empty: false };
    cut = next;
  }
  let hidden = 1;
  for (let at = trimmed.indexOf("\n", cut + 1); at !== -1; at = trimmed.indexOf("\n", at + 1)) {
    hidden += 1;
  }
  return { text: trimmed.slice(0, cut), hidden, empty: false };
}

interface ToolBodyProps {
  entry: PiToolEntry;
  cwd: string;
}

/**
 * The card body: an argument-driven preview that fills in live, superseded by the tool's own diff
 * once it returns one, plus the output stream.
 */
function ToolBody({ entry, cwd }: ToolBodyProps): JSX.Element {
  const [expanded, toggleExpanded] = useDisclosure(`output:${entry.id}`);
  const diff = hasDiff(entry);
  const { text, hidden, empty } = useMemo(
    () => collapseOutput(entry.output, expanded),
    [entry.output, expanded],
  );

  // A delta re-renders the whole transcript, so without this every open card would re-parse its
  // buffer on every token of every other card.
  const args = useMemo(
    () => readableArgs(entry),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- these two fields are the whole input
    [entry.args, entry.partialArgs],
  );
  const toolName = inferToolName(entry.toolName, args);
  const resolvedView = resolveToolView(toolName);
  const streaming = entry.phase === "generating";
  const Preview = resolvedView.Preview;
  const argumentPreview =
    !diff && Preview && args ? <Preview args={args} entry={entry} streaming={streaming} /> : null;
  const preview =
    !diff && args && (toolName === "edit" || toolName === "apply_patch") ? (
      <LiveFileDiffPreview toolName={toolName} args={args} cwd={cwd} fallback={argumentPreview} />
    ) : (
      argumentPreview
    );
  const label = (args && resolvedView.label?.(args, entry)) || fallbackLabel(entry, args);

  // Once a preview or diff is on screen, the tool's textual summary is redundant noise; keep the
  // output block for tools that actually stream something worth reading. todo_web's formatWeb dump
  // duplicates the graph card, so hide it whenever the web rendered.
  const hideTextOutput = Boolean(diff) || (toolName === "todo_web" && Boolean(preview));
  const showOutput = !hideTextOutput && (!empty || (!preview && !streaming));
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
          {text ? <AnsiText text={text} /> : <span className="pi-dim">Waiting for output…</span>}
        </pre>
      ) : null}
      {!diff && hidden > 0 ? (
        <button type="button" className="pi-tool-expand" onClick={toggleExpanded}>
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
  cwd,
  showHeader = true,
}: {
  entry: PiToolEntry;
  cwd: string;
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
      <ToolBody entry={entry} cwd={cwd} />
      <div className="pi-tool-duration">
        ◷ {duration ? `Took ${duration}` : entry.endedAt ? "Timing unavailable" : "In progress"}
      </div>
    </div>
  );
}

// Every delta produces a fresh entries array, so without memoisation one streamed token re-renders
// — and re-highlights, re-diffs, re-parses — every card in the conversation. The reducer keeps
// untouched entries identical, which is what makes the default shallow comparison enough.
const ToolCard = memo(function ToolCard({
  entry,
  cwd,
}: {
  entry: PiToolEntry;
  cwd: string;
}): JSX.Element {
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
      <ToolSection entry={entry} cwd={cwd} showHeader={false} />
    </div>
  );
});

const ParallelToolGroup = memo(
  function ParallelToolGroup({ entries, cwd }: { entries: PiToolEntry[]; cwd: string }) {
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
          <ToolSection key={entry.id} entry={entry} cwd={cwd} showHeader={index > 0} />
        ))}
      </div>
    );
  },
  // The group array is rebuilt on every transcript render; its members are not.
  (previous, next) =>
    previous.cwd === next.cwd &&
    previous.entries.length === next.entries.length &&
    previous.entries.every((entry, index) => entry === next.entries[index]),
);

function ThinkingBlock({ id, text }: { id: string; text: string }): JSX.Element {
  const [open, toggle] = useDisclosure(`thinking:${id}`);
  return (
    <div className="pi-thinking">
      <button type="button" onClick={toggle}>
        {open ? "▴ thinking" : "▾ thinking"}
      </button>
      {open ? <pre>{text}</pre> : null}
    </div>
  );
}

const Message = memo(function Message({ entry }: { entry: PiMessageEntry }): JSX.Element {
  const isUser = entry.role === "user";
  return (
    <div className={isUser ? "pi-message pi-user-message" : "pi-message pi-assistant-message"}>
      {entry.thinking ? <ThinkingBlock id={entry.id} text={entry.thinking} /> : null}
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
});

interface TranscriptRow {
  key: string;
  node: ReactNode;
}

/** Groups entries into the rows the transcript renders, coalescing parallel tool calls. */
export function buildRows(entries: PiEntry[], cwd: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === "message") {
      if (entry.text || entry.thinking || entry.error)
        rows.push({ key: entry.id, node: <Message entry={entry} /> });
      continue;
    }

    const groupId = entry.parallelGroup?.id;
    if (!groupId) {
      rows.push({ key: entry.id, node: <ToolCard entry={entry} cwd={cwd} /> });
      continue;
    }

    const group: PiToolEntry[] = [entry];
    while (true) {
      const next = entries[index + 1];
      if (next?.kind !== "tool" || next.parallelGroup?.id !== groupId) break;
      group.push(next);
      index += 1;
    }
    rows.push({ key: groupId, node: <ParallelToolGroup entries={group} cwd={cwd} /> });
  }
  return rows;
}

/**
 * Renders messages and coalesces adjacent sibling tool calls into one parallel card.
 *
 * Only the rows near the viewport are mounted. A row that scrolls out is replaced by a spacer of
 * the height it last measured, which keeps the scroll height — and therefore every scroll offset
 * and the follow-to-bottom writer in `PiAgentPane` — exactly as it was, while releasing the DOM,
 * the React fibers and the parsed markdown of a conversation that may run to thousands of rows.
 */
export function Transcript({
  entries,
  working = false,
  operationStatus,
  cwd,
  scrollRootRef,
}: {
  entries: PiEntry[];
  working?: boolean;
  operationStatus?: string;
  cwd: string;
  /** Scrolling ancestor, used as the intersection root. */
  scrollRootRef?: RefObject<HTMLElement | null>;
}): JSX.Element {
  const rows = useMemo(() => buildRows(entries, cwd), [entries, cwd]);

  // Held in state rather than a ref only so they may be read during render; they are never
  // replaced, so they never trigger one.
  const [disclosure] = useState(() => new Map<string, boolean>());
  const [heights] = useState(() => new Map<string, number>());
  const [nodeKeys] = useState(() => new WeakMap<Element, string>());
  const [rowNodes] = useState(() => new Map<string, HTMLElement>());
  const [nearViewport, setNearViewport] = useState<ReadonlySet<string>>(() => new Set<string>());
  const observers = useRef<{ visibility: IntersectionObserver; size: ResizeObserver } | null>(null);

  // Mounted regardless of the observer: the tail is where streaming lands, and on first paint
  // nothing has been measured yet, so the bottom of the transcript must be real content.
  const mountedKeys = useMemo(() => {
    const keys = new Set(nearViewport);
    for (let index = Math.max(0, rows.length - TAIL_ROWS); index < rows.length; index += 1) {
      keys.add(rows[index].key);
    }
    return keys;
  }, [nearViewport, rows]);
  const mountedRef = useRef(mountedKeys);
  useEffect(() => {
    mountedRef.current = mountedKeys;
  }, [mountedKeys]);

  useEffect(() => {
    const root = scrollRootRef?.current ?? null;
    const visibility = new IntersectionObserver(
      (records) => {
        setNearViewport((previous) => {
          let next = previous;
          for (const record of records) {
            const key = nodeKeys.get(record.target);
            if (key === undefined) continue;
            if (record.isIntersecting === previous.has(key)) continue;
            if (next === previous) next = new Set(previous);
            const mutable = next as Set<string>;
            if (record.isIntersecting) mutable.add(key);
            else mutable.delete(key);
          }
          return next;
        });
      },
      { root, rootMargin: `${OVERSCAN_PX}px 0px` },
    );
    // Spacers report the height they were given, which would pin a row to its own estimate.
    const size = new ResizeObserver((records) => {
      for (const record of records) {
        const key = nodeKeys.get(record.target);
        if (key === undefined || !mountedRef.current.has(key)) continue;
        const height = (record.target as HTMLElement).offsetHeight;
        if (height > 0) heights.set(key, height);
      }
    });
    observers.current = { visibility, size };
    for (const node of rowNodes.values()) {
      visibility.observe(node);
      size.observe(node);
    }
    return () => {
      visibility.disconnect();
      size.disconnect();
      observers.current = null;
    };
  }, [scrollRootRef, heights, nodeKeys, rowNodes]);

  const registerRow = useCallback(
    (key: string, node: HTMLElement | null): void => {
      const previous = rowNodes.get(key);
      if (previous && previous !== node) {
        observers.current?.visibility.unobserve(previous);
        observers.current?.size.unobserve(previous);
      }
      if (!node) {
        rowNodes.delete(key);
        return;
      }
      nodeKeys.set(node, key);
      rowNodes.set(key, node);
      observers.current?.visibility.observe(node);
      observers.current?.size.observe(node);
    },
    [nodeKeys, rowNodes],
  );

  // Measurements and disclosure flags for rows pi has dropped (a new session, a fork, a compaction)
  // would otherwise accumulate for the life of the pane.
  useEffect(() => {
    if (heights.size <= rows.length * 2 && disclosure.size <= rows.length * 2) return;
    const live = new Set(rows.map((row) => row.key));
    for (const key of heights.keys()) if (!live.has(key)) heights.delete(key);
    for (const key of disclosure.keys()) {
      if (!live.has(key.slice(key.indexOf(":") + 1))) disclosure.delete(key);
    }
  }, [rows, heights, disclosure]);

  return (
    <DisclosureContext.Provider value={disclosure}>
      <div className="pi-transcript">
        {rows.map((row) => (
          <Row
            key={row.key}
            rowKey={row.key}
            mounted={mountedKeys.has(row.key)}
            height={heights.get(row.key) ?? ESTIMATED_ROW_PX}
            register={registerRow}
          >
            {row.node}
          </Row>
        ))}
        {working || operationStatus ? (
          <div className="text-[var(--pi-dim)]">{operationStatus ?? "working…"}</div>
        ) : null}
      </div>
    </DisclosureContext.Provider>
  );
}

function Row({
  rowKey,
  mounted,
  height,
  register,
  children,
}: {
  rowKey: string;
  mounted: boolean;
  height: number;
  register: (key: string, node: HTMLElement | null) => void;
  children: ReactNode;
}): JSX.Element {
  const attach = useCallback(
    (node: HTMLDivElement | null) => register(rowKey, node),
    [register, rowKey],
  );
  return (
    <div ref={attach} style={mounted ? undefined : { height }} aria-hidden={!mounted}>
      {mounted ? children : null}
    </div>
  );
}
