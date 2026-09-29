import type { TerminalClipboardPayload } from "../../shared/types";

const PASTE_EVENT = "swath:paste";

/** Copy ordinary editor selections for Ctrl+C, which macOS does not map to native Copy. */
export function copyFocusedSelection(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey ||
    event.key.toLowerCase() !== "c"
  )
    return;
  const target = document.activeElement;
  const selection =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0)
      : window.getSelection()?.toString();
  // Leave Ctrl+C alone without a selection, especially for terminal interrupts.
  if (selection && document.execCommand("copy")) event.preventDefault();
}

/** Register a paste consumer on its actual editor, not every mounted pane in the window. */
export function listenForPaste(
  target: HTMLElement,
  paste: (payload: TerminalClipboardPayload) => void,
  onError: (error: unknown) => void = (error) => console.error("Clipboard paste failed", error),
): () => void {
  const listener = (event: Event): void => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    paste((event as CustomEvent<TerminalClipboardPayload>).detail);
  };
  const failure = (event: Event): void => {
    event.stopPropagation();
    onError((event as CustomEvent<unknown>).detail);
  };
  target.addEventListener(PASTE_EVENT, listener);
  target.addEventListener(`${PASTE_EVENT}-error`, failure);
  return () => {
    target.removeEventListener(PASTE_EVENT, listener);
    target.removeEventListener(`${PASTE_EVENT}-error`, failure);
  };
}

/** Deliver host and local menu paste to the editor that owned focus when paste was requested. */
export async function pasteIntoFocusedField(
  payload?: TerminalClipboardPayload,
  activePaneId?: string | null,
): Promise<void> {
  let target = document.activeElement;
  if (
    (target === document.body || target === document.documentElement) &&
    activePaneId &&
    !document.querySelector('[aria-modal="true"]')
  ) {
    const terminal = document.querySelector<HTMLElement>(
      `[data-terminal-pane-id="${CSS.escape(activePaneId)}"] .xterm-helper-textarea`,
    );
    if (terminal?.getClientRects().length) {
      terminal.focus();
      target = document.activeElement;
    }
  }
  if (!(target instanceof HTMLElement) || target === document.body) return;
  const field =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  if (field?.disabled || field?.readOnly) return;
  const value = field?.value;
  const start = field?.selectionStart;
  const end = field?.selectionEnd;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };
  target.addEventListener("blur", cancel, { once: true });
  window.addEventListener("blur", cancel, { once: true });
  try {
    const clipboard = payload ?? (await window.swath.clipboard.readForTerminal());
    if (cancelled || !target.isConnected || document.activeElement !== target) return;
    if (
      field &&
      (field.value !== value || field.selectionStart !== start || field.selectionEnd !== end)
    )
      return;
    const event = new CustomEvent<TerminalClipboardPayload>(PASTE_EVENT, {
      bubbles: true,
      cancelable: true,
      detail: clipboard,
    });
    if (!target.dispatchEvent(event) || !clipboard.text) return;
    // Never insert into an unclaimed xterm textarea or a custom editor after it unmounts.
    if (
      target.classList.contains("xterm-helper-textarea") ||
      target.hasAttribute("data-swath-paste-handler")
    )
      return;
    if (field) {
      const from = start ?? field.value.length;
      const to = end ?? from;
      const next = `${field.value.slice(0, from)}${clipboard.text}${field.value.slice(to)}`;
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, next);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      if (start !== null)
        field.setSelectionRange(from + clipboard.text.length, from + clipboard.text.length);
    } else if (target.isContentEditable) {
      // Native insertion preserves the editor's undo stack and input events.
      document.execCommand("insertText", false, clipboard.text);
    }
  } catch (error) {
    console.error("Unable to paste clipboard contents", error);
    if (!cancelled && target.isConnected && document.activeElement === target) {
      target.dispatchEvent(
        new CustomEvent(`${PASTE_EVENT}-error`, { bubbles: true, detail: error }),
      );
    }
  } finally {
    target.removeEventListener("blur", cancel);
    window.removeEventListener("blur", cancel);
  }
}
