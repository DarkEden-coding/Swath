import type { ShellProfile } from "../../../../shared/types";
import type { TerminalPastePayload } from "../hooks/useTerminalClipboard";
import { formatPathPaste } from "../../../utils/terminalPaste";
import { getModifiedEnterSequence, getTerminalKeyAction, shouldXtermHandleKeyEvent, type TerminalKeyEvent } from "../utils/terminalKeyboard";

interface Disposable {
  dispose: () => void;
}

export interface TerminalInputKeyboardEvent {
  key: string;
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
  pasteText: (data: string) => void;
}

const RECENT_SELECTION_MS = 2000;

export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  return (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" &&
      target instanceof HTMLTextAreaElement &&
      !target.classList.contains("xterm-helper-textarea"))
  );
}

function getClipboardEventText(event: TerminalInputClipboardEvent): string {
  return event.clipboardData?.getData("text/plain") ?? "";
}

function getClipboardEventFilePaths(event: TerminalInputClipboardEvent): string[] {
  const files = Array.from(event.clipboardData?.files ?? []);
  return files
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path));
}

function stopClipboardEvent(event: TerminalInputClipboardEvent): void {
  event.preventDefault();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

function isShiftEnter(event: TerminalKeyEvent): boolean {
  return event.type === "keydown" && event.key === "Enter" && Boolean(event.shiftKey) && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function createTerminalInputController({
  terminal,
  shellProfile,
  readClipboard,
  readClipboardText,
  writeClipboardText,
  writeTerminalData,
  openSearch,
  platform = "",
  onPasteError = (error) => console.error("Unable to paste from clipboard", error),
  now = () => Date.now(),
}: TerminalInputControllerOptions): TerminalInputController {
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
    const modifiedEnterSequence = isShiftEnter(event) ? "\x1b[13;2u" : getModifiedEnterSequence(event);
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

    if (event.type === "keydown" && getTerminalKeyAction(event, Boolean(getCopySelection(true))) === "copy") {
      event.preventDefault();
      void copy(true);
      return false;
    }

    return true;
  };

  terminal.attachCustomKeyEventHandler(handleXtermKeyEvent);
  disposables.push(() => terminal.attachCustomKeyEventHandler(() => true));

  const pasteText = (data: string): void => {
    if (!data) return;
    terminal.focus();
    terminal.paste(data);
  };

  const forwardPasteShortcutToTerminal = (): void => {
    terminal.focus();
    const sequence = platform === "win32" ? "\x1bv" : "\x16";
    if (writeTerminalData) {
      writeTerminalData(sequence);
    } else {
      terminal.paste(sequence);
    }
  };

  const pastePaths = (paths: string[]): void => {
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
    if (allowRecentSelection && now() - lastSelectionAt <= RECENT_SELECTION_MS) return lastSelection;
    return "";
  };

  const copy = async (allowRecentSelection = false): Promise<void> => {
    const selection = getCopySelection(allowRecentSelection);
    if (!selection) return;
    await writeClipboardText(selection);
  };

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const payload = readClipboard
        ? await readClipboard()
        : { text: (await readClipboardText?.()) ?? "", hasImage: false };
      if (payload.text) {
        pasteText(payload.text);
      } else if (payload.hasImage) {
        forwardPasteShortcutToTerminal();
      }
    } catch (error) {
      onPasteError(error);
    }
  };

  const handlePasteEvent = (event: TerminalInputClipboardEvent): boolean => {
    if (isEditableTarget(event.target)) return false;

    const text = getClipboardEventText(event);
    const filePaths = text ? [] : getClipboardEventFilePaths(event);
    stopClipboardEvent(event);
    if (text) {
      pasteText(text);
    } else if (filePaths.length > 0) {
      pastePaths(filePaths);
    } else {
      // Image-only clipboard paste events do not expose text/files to the webview.
      // Forward Ctrl+V to the terminal app so tools such as Pi extensions can read
      // the native OS clipboard themselves.
      forwardPasteShortcutToTerminal();
    }
    return true;
  };

  const handleCopyEvent = (event: TerminalInputClipboardEvent): void => {
    if (isEditableTarget(event.target) || !getCopySelection(true)) return;
    event.preventDefault();
    void copy(true);
  };

  const handleKeyDown = (event: TerminalInputKeyboardEvent): void => {
    if (isEditableTarget(event.target)) return;

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

  return {
    copy,
    dispose: () => {
      for (const dispose of disposables.splice(0).reverse()) dispose();
    },
    getCopySelection,
    handleCopyEvent,
    handleKeyDown,
    handlePasteEvent,
    pasteFromClipboard,
    pastePaths,
    pasteText,
  };
}
