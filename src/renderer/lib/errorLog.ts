/**
 * One place every failure is recorded, whether React can see it or not.
 *
 * Error boundaries only catch throws during render, lifecycle and effects; a throw inside an async
 * callback — a Tauri event listener, a promise rejection — escapes them all. Those used to vanish
 * into a console the packaged app never shows, so the app would simply go blank.
 *
 * Critical failures paint a full-screen overlay straight into the DOM, deliberately not through
 * React state, because React may be the thing that is broken. Everything else is recorded quietly
 * and read later in Settings → Diagnostics.
 */

/** What the user was doing when a failure landed, so a log entry is actionable. */
export interface ErrorContext {
  /** e.g. `click on button.pi-tool-expand "… 12 more lines"`. */
  action: string;
  at: number;
}

export interface ErrorEntry {
  id: number;
  time: number;
  /** What reported it: a boundary label, "Uncaught error", a subsystem name. */
  source: string;
  message: string;
  stack?: string;
  critical: boolean;
  /** The last user interaction before the failure, when one happened recently. */
  context?: ErrorContext;
}

/** Interactions older than this are not plausibly the cause, so they are not blamed. */
const CONTEXT_MAX_AGE_MS = 10_000;

/** Kept small: this is a diagnostic tail, not an audit trail. */
const MAX_ENTRIES = 100;

let entries: ErrorEntry[] = [];
let nextId = 1;
let lastInteraction: ErrorContext | undefined;
const listeners = new Set<() => void>();

export function getErrorLog(): ErrorEntry[] {
  return entries;
}

export function clearErrorLog(): void {
  entries = [];
  notify();
}

export function subscribeToErrorLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** A short, human-readable description of an element: tag, identity, and its own text. */
function describeElement(element: Element): string {
  const parts = [element.tagName.toLowerCase()];
  if (element.id) parts.push(`#${element.id}`);
  const className = typeof element.className === "string" ? element.className.trim() : "";
  const first = className.split(/\s+/).filter(Boolean)[0];
  if (first) parts.push(`.${first}`);
  const label =
    element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? "";
  return label ? `${parts.join("")} "${label}"` : parts.join("");
}

function describeValue(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, stack: value.stack };
  }
  return { message: String(value) };
}

/**
 * Records a failure. `critical` failures also take over the screen — reserve it for the ones that
 * leave the app unusable, so a contained failure does not blot out a working window.
 */
export function reportError(source: string, value: unknown, critical = false): void {
  const { message, stack } = describeValue(value);
  console.error(`[${source}]`, value);

  const context =
    lastInteraction && Date.now() - lastInteraction.at < CONTEXT_MAX_AGE_MS
      ? lastInteraction
      : undefined;
  const entry: ErrorEntry = {
    id: nextId++,
    time: Date.now(),
    source,
    message,
    stack,
    critical,
    context,
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  notify();

  if (critical) showOverlay(entry);
}

const OVERLAY_ID = "swath-crash-overlay";

function showOverlay(entry: ErrorEntry): void {
  const existing = document.getElementById(OVERLAY_ID);
  const overlay = existing ?? document.createElement("div");
  if (!existing) {
    overlay.id = OVERLAY_ID;
    overlay.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:2147483647;overflow:auto;padding:16px;" +
        "background:#0d1117;color:#f87171;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap",
    );
    const dismiss = document.createElement("button");
    dismiss.textContent = "dismiss";
    dismiss.setAttribute(
      "style",
      "position:sticky;top:0;float:right;border:1px solid #30363d;color:#8b949e;padding:2px 8px",
    );
    dismiss.onclick = () => overlay.remove();
    overlay.appendChild(dismiss);
    document.body.appendChild(overlay);
  }
  const block = document.createElement("div");
  block.style.marginBottom = "12px";
  block.textContent = [
    entry.source,
    entry.message,
    entry.context ? `while: ${entry.context.action}` : "",
    entry.stack ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  overlay.appendChild(block);
}

/**
 * Starts recording. Failures React cannot catch are reported here as non-critical: an uncaught
 * listener error or a rejected promise usually leaves the app running, and the boundaries report
 * the ones that do not.
 */
export function installErrorLog(): void {
  window.addEventListener("error", (event) => {
    reportError("Uncaught error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError("Unhandled promise rejection", event.reason);
  });

  const remember = (kind: string, target: EventTarget | null): void => {
    const action =
      target instanceof Element ? `${kind} on ${describeElement(target)}` : `${kind} (no element)`;
    lastInteraction = { action, at: Date.now() };
  };
  window.addEventListener("click", (event) => remember("click", event.target), true);
  window.addEventListener(
    "keydown",
    (event) => remember(`key ${event.key}`, event.target),
    true,
  );
}
