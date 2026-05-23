import type { ShellProfile } from "../../../../shared/types";
import { formatPathPaste } from "../../../utils/terminalPaste";
import { getTerminalKeyAction, shouldXtermHandleKeyEvent } from "../utils/terminalKeyboard";

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
  onSelectionChange: (listener: () => void) => Disposable;
  paste: (data: string) => void;
  textarea?: HTMLElement;
}

export interface TerminalInputControllerOptions {
  terminal: TerminalInputTerminal;
  shellProfile: ShellProfile | null;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  openSearch: () => void;
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

function getPasteEventData(event: TerminalInputClipboardEvent, shellCommand: string | undefined): string {
  const text = getClipboardEventText(event);
  if (text) return text;

  const filePaths = getClipboardEventFilePaths(event);
  return filePaths.length > 0 ? formatPathPaste(filePaths, shellCommand) : "";
}

function stopClipboardEvent(event: TerminalInputClipboardEvent): void {
  event.preventDefault();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
}

export function createTerminalInputController({
  terminal,
  shellProfile,
  readClipboardText,
  writeClipboardText,
  openSearch,
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
    pasteText(await readClipboardText());
  };

  const handlePasteEvent = (event: TerminalInputClipboardEvent): boolean => {
    if (isEditableTarget(event.target)) return false;

    const data = getPasteEventData(event, shellCommand);
    if (!data) return false;

    stopClipboardEvent(event);
    pasteText(data);
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
    pasteText,
  };
}
