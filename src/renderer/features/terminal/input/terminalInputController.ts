import type { ShellProfile } from "../../../../shared/types";
import { listenForPaste } from "../../../app/clipboardPaste";
import {
  formatPathPaste,
  getClipboardEventFilePaths,
  getClipboardEventText,
  type TerminalPastePayload,
} from "../../../utils/terminalPaste";
import {
  getModifiedEnterSequence,
  getTerminalKeyAction,
  shouldXtermHandleKeyEvent,
  type TerminalKeyEvent,
} from "../utils/terminalKeyboard";

interface Disposable {
  dispose: () => void;
}

export interface TerminalInputKeyboardEvent {
  key: string;
  defaultPrevented?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
  preventDefault: () => void;
}

export interface TerminalInputClipboardEvent {
  target?: EventTarget | null;
  clipboardData?: {
    getData: (type: string) => string;
    setData?: (type: string, data: string) => void;
    files?: ArrayLike<File | { path?: string }>;
  } | null;
  preventDefault: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
}

export interface TerminalInputTerminal {
  attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => void;
  element?: HTMLElement;
  focus: () => void;
  getSelection: () => string;
  modes?: {
    readonly bracketedPasteMode?: boolean;
  };
  onSelectionChange: (listener: () => void) => Disposable;
  paste: (data: string) => void;
  textarea?: HTMLElement;
}

export interface TerminalInputControllerOptions {
  terminal: TerminalInputTerminal;
  shellProfile: ShellProfile | null;
  readClipboard?: () => Promise<TerminalPastePayload>;
  /** @deprecated Use readClipboard. */
  readClipboardText?: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  writeTerminalData?: (data: string) => void;
  openSearch: () => void;
  platform?: string;
  /** Whether filesystem paths and image clipboard shortcuts belong to the terminal's device. */
  isLocalSession?: boolean;
  onPasteError?: (error: unknown) => void;
  now?: () => number;
}

export interface TerminalInputController {
  copy: (allowRecentSelection?: boolean) => Promise<void>;
  dispose: () => void;
  getCopySelection: (allowRecentSelection: boolean) => string;
  handleCopyEvent: (event: TerminalInputClipboardEvent) => void;
  handleKeyDown: (event: TerminalInputKeyboardEvent) => void;
  handlePasteEvent: (event: TerminalInputClipboardEvent) => boolean;
  pasteFromClipboard: () => Promise<void>;
  pastePaths: (paths: string[]) => void;
  pastePayload: (payload: TerminalPastePayload) => void;
  pasteText: (data: string) => void;
}

const RECENT_SELECTION_MS = 2000;

/** Return whether keyboard or clipboard input belongs to a regular editor control. */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  return (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" &&
      target instanceof HTMLTextAreaElement &&
      !target.classList.contains("xterm-helper-textarea")) ||
    (typeof HTMLElement !== "undefined" &&
      target instanceof HTMLElement &&
      target.isContentEditable)
  );
}

function stopClipboardEvent(event: TerminalInputClipboardEvent): void {
  event.preventDefault();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

function isShiftEnter(event: TerminalKeyEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    Boolean(event.shiftKey) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

/** Create the keyboard, selection, and clipboard controller for an xterm instance. */
export function createTerminalInputController({
  terminal,
  shellProfile,
  readClipboard,
  readClipboardText,
  writeClipboardText,
  writeTerminalData,
  openSearch,
  platform = "",
  isLocalSession = true,
  onPasteError = (error) => console.error("Unable to paste from clipboard", error),
  now = () => Date.now(),
}: TerminalInputControllerOptions): TerminalInputController {
  let disposed = false;
  let focusVersion = 0;
  let lastSelection = terminal.getSelection();
  let lastSelectionAt = lastSelection ? now() : 0;
  const disposables: Array<() => void> = [];
  const shellCommand = shellProfile?.command;

  const selectionDisposable: Disposable = terminal.onSelectionChange(() => {
    const selection = terminal.getSelection();
    if (!selection) return;
    lastSelection = selection;
    lastSelectionAt = now();
  });
  disposables.push(() => selectionDisposable.dispose());

  const handleXtermKeyEvent = (event: KeyboardEvent): boolean => {
    const modifiedEnterSequence = isShiftEnter(event)
      ? "\x1b[13;2u"
      : getModifiedEnterSequence(event);
    if (modifiedEnterSequence) {
      event.preventDefault();
      if (writeTerminalData) {
        writeTerminalData(modifiedEnterSequence);
      } else {
        terminal.paste(modifiedEnterSequence);
      }
      return false;
    }

    if (!shouldXtermHandleKeyEvent(event)) return false;

    if (
      event.type === "keydown" &&
      getTerminalKeyAction(event, Boolean(getCopySelection(true))) === "copy"
    ) {
      event.preventDefault();
      void copy(true);
      return false;
    }

    return true;
  };

  terminal.attachCustomKeyEventHandler(handleXtermKeyEvent);
  disposables.push(() => terminal.attachCustomKeyEventHandler(() => true));

  const pasteText = (data: string): void => {
    if (disposed || !data) return;
    terminal.focus();
    terminal.paste(data);
  };

  const forwardPasteShortcutToTerminal = (): void => {
    if (disposed) return;
    if (!isLocalSession) {
      onPasteError(
        new Error(
          "Remote terminal image paste is not supported. Upload the image on the remote device or use a Pi composer.",
        ),
      );
      return;
    }
    terminal.focus();
    const sequence = platform === "win32" ? "\x1bv" : "\x16";
    if (writeTerminalData) {
      writeTerminalData(sequence);
    } else {
      terminal.paste(sequence);
    }
  };

  const pastePaths = (paths: string[]): void => {
    if (disposed || paths.length === 0) return;
    if (!isLocalSession) {
      onPasteError(
        new Error(
          "Local files cannot be pasted as remote paths. Upload them to the remote device first.",
        ),
      );
      return;
    }
    const imagePaths = paths.filter((path) => /\.(?:png|jpe?g|gif|webp)$/i.test(path));
    const otherPaths = paths.filter((path) => !imagePaths.includes(path));
    for (const path of imagePaths) {
      if (writeTerminalData) {
        const encodedPath = btoa(String.fromCharCode(...new TextEncoder().encode(path)));
        writeTerminalData(`\x1b]777;swath-image=${encodedPath}\x07`);
      } else {
        pasteText(formatPathPaste([path], shellCommand));
      }
    }
    if (otherPaths.length > 0) pasteText(formatPathPaste(otherPaths, shellCommand));
  };

  const getCopySelection = (allowRecentSelection: boolean): string => {
    const selection = terminal.getSelection();
    if (selection) return selection;
    if (allowRecentSelection && now() - lastSelectionAt <= RECENT_SELECTION_MS)
      return lastSelection;
    return "";
  };

  const copy = async (allowRecentSelection = false): Promise<void> => {
    const selection = getCopySelection(allowRecentSelection);
    if (disposed || !selection) return;
    try {
      await writeClipboardText(selection);
    } catch (error) {
      onPasteError(error);
    }
  };

  const pastePayload = (payload: TerminalPastePayload): void => {
    if (disposed) return;
    if (payload.text) pasteText(payload.text);
    else if (payload.hasImage) forwardPasteShortcutToTerminal();
  };

  const pasteFromClipboard = async (): Promise<void> => {
    if (disposed) return;
    const requestedFocus = focusVersion;
    try {
      const payload = readClipboard
        ? await readClipboard()
        : { text: (await readClipboardText?.()) ?? "", hasImage: false };
      if (!disposed && requestedFocus === focusVersion) pastePayload(payload);
    } catch (error) {
      onPasteError(error);
    }
  };

  const handlePasteEvent = (event: TerminalInputClipboardEvent): boolean => {
    if (disposed || isEditableTarget(event.target)) return false;

    const text = getClipboardEventText(event);
    const filePaths = text ? [] : getClipboardEventFilePaths(event);
    stopClipboardEvent(event);
    if (text) {
      pasteText(text);
    } else if (filePaths.length > 0) {
      pastePaths(filePaths);
    } else {
      // Empty events are not evidence of an image. Confirm with the clipboard owner.
      void pasteFromClipboard();
    }
    return true;
  };

  const handleCopyEvent = (event: TerminalInputClipboardEvent): void => {
    if (disposed || isEditableTarget(event.target)) return;
    const selection = getCopySelection(true);
    if (!selection) return;
    stopClipboardEvent(event);
    // The native copy event has clipboard write permission even when the async browser API does not.
    if (event.clipboardData?.setData) event.clipboardData.setData("text/plain", selection);
    else void copy(true);
  };

  const handleKeyDown = (event: TerminalInputKeyboardEvent): void => {
    if (disposed || event.defaultPrevented || isEditableTarget(event.target)) return;

    const action = getTerminalKeyAction(event, Boolean(getCopySelection(true)));
    if (action === "copy") {
      event.preventDefault();
      void copy(true);
      return;
    }

    if (action === "find") {
      event.preventDefault();
      openSearch();
    }
  };

  const addPasteListener = (target: HTMLElement | undefined): void => {
    if (!target) return;
    const listener = (event: ClipboardEvent): void => {
      handlePasteEvent(event);
    };
    target.addEventListener("paste", listener, { capture: true });
    disposables.push(() => target.removeEventListener("paste", listener, { capture: true }));
  };

  addPasteListener(terminal.textarea);
  addPasteListener(terminal.element);
  const invalidatePendingPaste = (): void => {
    focusVersion += 1;
  };
  terminal.textarea?.addEventListener("blur", invalidatePendingPaste);
  disposables.push(() => terminal.textarea?.removeEventListener("blur", invalidatePendingPaste));
  if (typeof window !== "undefined") {
    window.addEventListener("blur", invalidatePendingPaste);
    disposables.push(() => window.removeEventListener("blur", invalidatePendingPaste));
  }
  if (terminal.element)
    disposables.push(listenForPaste(terminal.element, pastePayload, onPasteError));

  return {
    copy,
    dispose: () => {
      disposed = true;
      for (const dispose of disposables.splice(0).reverse()) dispose();
    },
    getCopySelection,
    handleCopyEvent,
    handleKeyDown,
    handlePasteEvent,
    pasteFromClipboard,
    pastePaths,
    pastePayload,
    pasteText,
  };
}
