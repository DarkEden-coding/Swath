/**
 * Per-tool card rendering, driven by arguments rather than output.
 *
 * Every view here is fed by `readableArgs`, which returns the settled arguments once pi has parsed
 * them and a best-effort reading of the streaming buffer before that. Because the reducer now learns
 * the tool name at `toolcall_start`, the right view is picked from the very first delta — so a card
 * fills in live as the model writes the call, instead of showing raw JSON and then jumping to a
 * finished diff.
 *
 * Views are looked up by tool name and fall back to `genericView`, which renders any tool's
 * arguments as labelled fields. Adding a nicer view for a new tool means adding one entry to
 * `TOOL_VIEWS`; doing nothing still produces a live, structured card.
 *
 * Schemas were read from the installed tool definitions (pi's built-ins under `dist/core/tools`,
 * `@heyhuynhgiabuu/pi-diff` for `apply_patch`, and `~/.pi/agent/extensions` for the rest), so the
 * field names below are the real ones. Aliases are still accepted where a tool is likely to be
 * swapped for a similar one from another package.
 */

import { useEffect, useState } from "react";
import { PatchView, WholeFileView } from "./DiffView";
import type { PiToolEntry } from "./eventReducer";
import { TodoWebPreview, todoWebLabel } from "./TodoWebPreview";

export interface ToolViewProps {
  args: Record<string, unknown>;
  entry: PiToolEntry;
  /** True while arguments are still streaming, so any value may be truncated mid-word. */
  streaming: boolean;
}

export interface ToolView {
  /** Header line for the card. Receives partial arguments, so it must tolerate missing fields. */
  label?: (args: Record<string, unknown>, entry: PiToolEntry) => string | null;
  /** Body rendered from arguments. Shown from the first delta onward. */
  Preview?: (props: ToolViewProps) => JSX.Element | null;
}

// ---------------------------------------------------------------------------
// Argument readers
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function list(args: Record<string, unknown> | undefined, ...keys: string[]): unknown[] {
  if (!args) return [];
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trims a value to a single readable line for a header. */
function oneLine(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `path/to/file.ts` → `file.ts`, for headers where the full path is already on the card. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ---------------------------------------------------------------------------
// Shared presentation
// ---------------------------------------------------------------------------

/** The blinking caret that marks the value currently being written. */
function Caret(): JSX.Element {
  return <span className="pi-streaming-cursor">▍</span>;
}

function FieldRow({ name, children }: { name: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="pi-field">
      <span className="pi-field-name">{name}</span>
      <span className="pi-field-value">{children}</span>
    </div>
  );
}

/** A multi-line value, scrollable rather than unbounded. */
function TextBlock({ text, caret }: { text: string; caret?: boolean }): JSX.Element {
  return (
    <pre className="pi-field-text">
      {text}
      {caret ? <Caret /> : null}
    </pre>
  );
}

/**
 * Renders scalar arguments as labelled rows and structured ones as indented sub-blocks.
 *
 * This is what gives every unrecognised tool — including extension tools that do not exist yet — a
 * live-filling structured card rather than a wall of JSON.
 */
function FieldList({
  args,
  streaming,
  skip = [],
}: {
  args: Record<string, unknown>;
  streaming: boolean;
  skip?: string[];
}): JSX.Element | null {
  const keys = Object.keys(args).filter((key) => !skip.includes(key));
  if (!keys.length) return null;
  // The newest key is the one still being written, so only it gets the caret.
  const lastKey = keys[keys.length - 1];

  return (
    <div className="pi-fields">
      {keys.map((key) => {
        const value = args[key];
        const live = streaming && key === lastKey;

        if (typeof value === "string") {
          return value.includes("\n") ? (
            <div key={key} className="pi-field pi-field-block">
              <span className="pi-field-name">{key}</span>
              <TextBlock text={value} caret={live} />
            </div>
          ) : (
            <FieldRow key={key} name={key}>
              {value}
              {live ? <Caret /> : null}
            </FieldRow>
          );
        }

        if (typeof value === "number" || typeof value === "boolean") {
          return (
            <FieldRow key={key} name={key}>
              {String(value)}
            </FieldRow>
          );
        }

        if (value === null || value === undefined) {
          return (
            <FieldRow key={key} name={key}>
              <span className="pi-dim">—</span>
            </FieldRow>
          );
        }

        return (
          <div key={key} className="pi-field pi-field-block">
            <span className="pi-field-name">
              {key}
              {Array.isArray(value) ? ` (${value.length})` : ""}
            </span>
            <TextBlock text={JSON.stringify(value, null, 2)} caret={live} />
          </div>
        );
      })}
    </div>
  );
}

/** A `- old` / `+ new` pair, the shape of a replacement before any file has been touched. */
function ReplacementView({
  oldText,
  newText,
  caret,
}: {
  oldText?: string;
  newText?: string;
  caret?: boolean;
}): JSX.Element | null {
  if (oldText === undefined && newText === undefined) return null;
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {oldText !== undefined ? (
        <pre className="whitespace-pre-wrap break-words bg-[#2b1417] px-2 text-[var(--pi-red)]">
          {oldText
            .split("\n")
            .map((line) => `- ${line}`)
            .join("\n")}
        </pre>
      ) : null}
      {newText !== undefined ? (
        <pre className="whitespace-pre-wrap break-words bg-[#12261a] px-2 text-[var(--pi-green)]">
          {newText
            .split("\n")
            .map((line) => `+ ${line}`)
            .join("\n")}
          {caret ? <Caret /> : null}
        </pre>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File-mutating tools
// ---------------------------------------------------------------------------

/**
 * Re-renders the calling component once per second while `active`, returning the current time.
 *
 * Live timers must tick from inside their own component: the transcript rows are memoised, so an
 * interval in a parent would either re-render every card or never fire again. The clock is read in
 * effects and state rather than during render, per the React purity rules.
 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = (): void => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Formats a span of milliseconds in the compact form the TUI extension uses. */
export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/** The count-up that replaces "In progress" on a tool card still running. */
export function LiveElapsed({ startedAt }: { startedAt: number }): JSX.Element {
  const now = useTicker(true);
  return <>◷ {formatElapsed(Math.max(0, now - startedAt))}</>;
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A ring that drains over a `background_terminal_control` wait's `timeoutSeconds`, with the
 * seconds remaining beside it. Draws down from `startedAt`, which is when the wait began.
 */
function WaitCountdown({
  entry,
  timeoutSeconds,
}: {
  entry: PiToolEntry;
  timeoutSeconds: number;
}): JSX.Element {
  const now = useTicker(entry.endedAt === undefined);
  const total = timeoutSeconds * 1_000;
  const elapsed = Math.max(0, (entry.endedAt ?? now) - entry.startedAt);
  const remaining = Math.max(0, total - elapsed);
  const fraction = total > 0 ? remaining / total : 0;
  return (
    <span className="pi-wait-ring">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={RING_RADIUS} className="pi-wait-ring-track" />
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          className="pi-wait-ring-fill"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {Math.ceil(remaining / 1_000)}s
    </span>
  );
}

/**
 * `background_terminal_control` — `{ id, action, timeoutSeconds? }`.
 *
 * A `wait` is the one control action that blocks visibly, so it gets the countdown ring; the rest
 * are instant and fall back to the generic field list.
 */
function BackgroundTerminalControlPreview({ args, entry, streaming }: ToolViewProps): JSX.Element | null {
  const action = str(args, "action");
  const timeout = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined;
  if (action !== "wait") return <FieldList args={args} streaming={streaming} />;
  return (
    <div className="pi-field pi-field-block">
      <span className="pi-field-name">wait</span>
      <span className="pi-field-value">
        {timeout !== undefined ? (
          <WaitCountdown entry={entry} timeoutSeconds={timeout} />
        ) : (
          <>waiting for terminal…</>
        )}
      </span>
    </div>
  );
}

/**
 * `edit` — `{ path, edits: [{ oldText, newText }] }`.
 *
 * Line numbers are deliberately absent: until the tool runs, the replacement has not been located in
 * the file, so any gutter would be a guess. The authoritative numbered diff replaces this the moment
 * `tool_execution_end` lands.
 */
function EditPreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  const edits = list(args, "edits");
  const changes = edits.length
    ? edits.filter(isRecord)
    : args.oldText !== undefined || args.newText !== undefined || args.old_string !== undefined
      ? [args]
      : [];
  if (!changes.length) return null;

  return (
    <div>
      {changes.map((change, index) => (
        <div key={index} className="border-t border-[var(--pi-border-muted)] first:border-t-0">
          {changes.length > 1 ? (
            <div className="px-2.5 py-1 text-[11px] text-[var(--pi-muted)]">
              edit {index + 1} of {changes.length}
            </div>
          ) : null}
          <ReplacementView
            oldText={str(change, "oldText", "old_string", "old_str")}
            newText={str(change, "newText", "new_string", "new_str")}
            caret={streaming && index === changes.length - 1}
          />
        </div>
      ))}
    </div>
  );
}

/** `write` — `{ path, content }`, previewed as a file made entirely of additions. */
function WritePreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  const content = typeof args.content === "string" ? args.content : undefined;
  const path = str(args, "path", "file_path", "filePath");
  if (content === undefined) return null;
  return (
    <div>
      <WholeFileView content={content} filePath={path} type="add" />
      {streaming ? (
        <div className="px-2.5 py-1 text-[11px] text-[var(--pi-dim)]">
          writing… <Caret />
        </div>
      ) : null}
    </div>
  );
}

/**
 * `apply_patch` — `{ changes: [{ path, action, content?, oldText?, newText?, movePath? }] }`.
 *
 * Each action gets the rendering that suits it: a replacement pair for updates, a whole-file block
 * for adds and deletes, and a path arrow for moves.
 */
function ApplyPatchPreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  // `changes` is the pi-diff shape; a plain `patch` string is accepted for patch tools that take one.
  const patch = str(args, "patch", "input", "diff");
  const changes = list(args, "changes").filter(isRecord);
  if (!changes.length) return patch ? <PatchView patch={patch} /> : null;

  return (
    <div>
      {changes.map((change, index) => {
        const path = str(change, "path");
        const action = str(change, "action") ?? "update";
        const movePath = str(change, "movePath");
        const content = typeof change.content === "string" ? change.content : undefined;
        const live = streaming && index === changes.length - 1;

        return (
          <div key={index} className="border-t border-[var(--pi-border-muted)] first:border-t-0">
            <div className="px-2.5 py-1 text-[11px] text-[var(--pi-muted)]">
              <span className="mr-2 uppercase text-[var(--pi-dim)]">{action}</span>
              <span className="break-all">{path ?? "…"}</span>
              {movePath ? <span className="break-all"> → {movePath}</span> : null}
            </div>
            {action === "add" && content !== undefined ? (
              <WholeFileView content={content} filePath={path} type="add" />
            ) : (
              <ReplacementView
                oldText={str(change, "oldText")}
                newText={str(change, "newText")}
                caret={live}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Extension tools
// ---------------------------------------------------------------------------

/**
 * `parallel_agents` — `{ tasks: [{ name?, model, reasoningLevel, prompt }], blocking? }`.
 *
 * The card that most needed this: a fan-out of long prompts previously arrived as one unreadable
 * JSON blob. Each task gets its own row, and its prompt streams in place.
 */
function ParallelAgentsPreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  const tasks = list(args, "tasks").filter(isRecord);
  if (!tasks.length) return null;

  return (
    <div className="pi-subagents">
      {tasks.map((task, index) => {
        const name = str(task, "name");
        const model = str(task, "model");
        const level = str(task, "reasoningLevel");
        const prompt = str(task, "prompt");
        return (
          <div key={index} className="pi-subagent">
            <div className="pi-subagent-head">
              <span className="pi-subagent-index">{index + 1}</span>
              <span className="pi-subagent-name">{name ?? model ?? "task"}</span>
              {model ? <span className="pi-dim">{model}</span> : null}
              {level ? <span className="pi-dim">· {level}</span> : null}
            </div>
            {prompt ? (
              <TextBlock text={prompt} caret={streaming && index === tasks.length - 1} />
            ) : (
              <div className="pi-dim px-2 py-1 text-[11px]">
                waiting for prompt… <Caret />
              </div>
            )}
          </div>
        );
      })}
      {args.blocking === false ? (
        <div className="px-2 py-1 text-[11px] text-[var(--pi-dim)]">non-blocking run</div>
      ) : null}
    </div>
  );
}

/** `ask_user_questions` — `{ questions: [{ question, options: string[], images?: string[] }] }`. */
function QuestionsPreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  const questions = list(args, "questions").filter(isRecord);
  if (!questions.length) return null;

  return (
    <div className="pi-fields">
      {questions.map((item, index) => {
        const question = str(item, "question");
        const options = list(item, "options").filter(
          (option): option is string => typeof option === "string",
        );
        const images = list(item, "images").filter(
          (image): image is string => typeof image === "string",
        );
        return (
          <div key={index} className="pi-field pi-field-block">
            <span className="pi-field-name">Q{index + 1}</span>
            <div className="min-w-0">
              <div className="break-words">
                {question ?? "…"}
                {streaming && index === questions.length - 1 && !options.length ? <Caret /> : null}
              </div>
              {options.map((option, optionIndex) => (
                <div key={optionIndex} className="pi-dim break-words">
                  · {option}
                </div>
              ))}
              {images.length ? (
                <div className="pi-dim break-words">
                  🖼 {images.length} image{images.length === 1 ? "" : "s"}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** `background_terminal` — `{ command?, commands?, cwd?, maxRuntimeSeconds? }`. */
function BackgroundTerminalPreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  const commands = list(args, "commands").filter(
    (value): value is string => typeof value === "string",
  );
  const single = str(args, "command");
  const all = commands.length ? commands : single ? [single] : [];
  if (!all.length) return <FieldList args={args} streaming={streaming} />;

  return (
    <div>
      <pre className="pi-field-text">
        {all.map((command) => `$ ${command}`).join("\n")}
        {streaming ? <Caret /> : null}
      </pre>
      <FieldList args={args} streaming={false} skip={["command", "commands"]} />
    </div>
  );
}

/** `bash` — the command is already the header, so only a multi-line script needs a body. */
function BashPreview({ args, streaming }: ToolViewProps): JSX.Element | null {
  const command = str(args, "command");
  if (!command || !command.includes("\n")) return null;
  return <TextBlock text={command} caret={streaming} />;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const genericView: ToolView = {
  Preview: ({ args, streaming }) => <FieldList args={args} streaming={streaming} />,
};

function pathLabel(icon: string, name: string) {
  return (args: Record<string, unknown>): string => {
    const path = str(args, "path", "file_path", "filePath");
    return path ? `${icon} ${name} ${path}` : `${icon} ${name}`;
  };
}

const TOOL_VIEWS: Record<string, ToolView> = {
  bash: {
    label: (args) => {
      const command = str(args, "command");
      return command ? `$ ${oneLine(command)}` : "$ …";
    },
    Preview: BashPreview,
  },

  read: {
    label: (args) => {
      const path = str(args, "path", "file_path", "filePath");
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const range =
        offset !== undefined || limit !== undefined ? ` (${offset ?? 0}+${limit ?? "…"})` : "";
      return path ? `→ Read ${path}${range}` : "→ Read";
    },
  },

  ls: { label: (args) => `▤ List ${str(args, "path") ?? "."}` },

  grep: {
    label: (args) => {
      const pattern = str(args, "pattern");
      const where = str(args, "path", "glob");
      return pattern ? `⌕ Grep ${oneLine(pattern, 60)}${where ? ` in ${where}` : ""}` : "⌕ Grep";
    },
    Preview: ({ args, streaming }) => (
      <FieldList args={args} streaming={streaming} skip={["pattern"]} />
    ),
  },

  find: {
    label: (args) => {
      const pattern = str(args, "pattern");
      return pattern ? `⌕ Find ${pattern}` : "⌕ Find";
    },
    Preview: ({ args, streaming }) => (
      <FieldList args={args} streaming={streaming} skip={["pattern"]} />
    ),
  },

  edit: { label: pathLabel("✎", "Edit"), Preview: EditPreview },
  write: { label: pathLabel("✎", "Write"), Preview: WritePreview },
  create: { label: pathLabel("✎", "Create"), Preview: WritePreview },

  apply_patch: {
    label: (args) => {
      const changes = list(args, "changes");
      if (!changes.length) return "⇄ apply_patch";
      const names = changes
        .filter(isRecord)
        .map((change) => str(change, "path"))
        .filter((path): path is string => Boolean(path))
        .map(baseName);
      const suffix = names.length ? ` · ${oneLine(names.join(", "), 70)}` : "";
      return `⇄ apply_patch (${changes.length} change${changes.length === 1 ? "" : "s"})${suffix}`;
    },
    Preview: ApplyPatchPreview,
  },

  parallel_agents: {
    label: (args) => {
      const tasks = list(args, "tasks");
      return tasks.length
        ? `⇉ ${tasks.length} sub-agent${tasks.length === 1 ? "" : "s"}`
        : "⇉ Parallel agents";
    },
    Preview: ParallelAgentsPreview,
  },

  ask_user_questions: {
    label: (args) => {
      const questions = list(args, "questions");
      return questions.length
        ? `? ${questions.length} question${questions.length === 1 ? "" : "s"}`
        : "? Ask user";
    },
    Preview: QuestionsPreview,
  },

  todo_web: {
    label: (args, entry) => todoWebLabel(args, entry),
    Preview: TodoWebPreview,
  },

  background_terminal_control: {
    label: (args) => {
      const action = str(args, "action");
      if (action === "wait") {
        const timeout = typeof args.timeoutSeconds === "number" ? ` ${args.timeoutSeconds}s` : "";
        return `⟳ Terminal wait${timeout}`;
      }
      return action ? `⟳ Terminal ${action}` : "⟳ Terminal control";
    },
    Preview: BackgroundTerminalControlPreview,
  },

  background_terminal: {
    label: (args) => {
      const command = str(args, "command") ?? (list(args, "commands")[0] as string | undefined);
      return command ? `⟳ Background $ ${oneLine(command)}` : "⟳ Background terminal";
    },
    Preview: BackgroundTerminalPreview,
  },

  remember: {
    label: (args) => `✱ Remember ${str(args, "action") ?? ""}`.trimEnd(),
  },
};

/** Search tools all take a query and differ only in name. */
for (const name of [
  "brave_llm_search",
  "exa_web_search",
  "context7_search",
  "context7_query_docs",
  "web_search",
]) {
  TOOL_VIEWS[name] = {
    label: (args) => {
      const query = str(args, "query", "q", "search");
      return query ? `⌕ ${oneLine(query, 90)}` : "⌕ Search";
    },
    Preview: ({ args, streaming }) => (
      <FieldList args={args} streaming={streaming} skip={["query"]} />
    ),
  };
}

/**
 * Identifies file tools when a provider withholds the tool name until `toolcall_end`.
 * Their argument shapes are distinct, so the preview does not need to wait for execution to start.
 */
export function inferToolName(toolName: string, args: Record<string, unknown> | undefined): string {
  if (toolName !== "tool" || !args) return toolName;
  if (Array.isArray(args.changes)) return "apply_patch";
  if (
    typeof args.path === "string" &&
    (Array.isArray(args.edits) || args.oldText !== undefined || args.old_string !== undefined)
  ) {
    return "edit";
  }
  return toolName;
}

/** The view for a tool, falling back to the generic field list. */
export function resolveToolView(toolName: string): ToolView {
  return TOOL_VIEWS[toolName] ?? genericView;
}
