export interface TerminalKeyEvent {
  type?: string;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export type TerminalKeyAction = "copy" | "find" | "none";

export function getModifiedEnterSequence(event: TerminalKeyEvent): string | null {
  if (event.type && event.type !== "keydown") return null;
  if (event.key !== "Enter" || event.altKey || event.shiftKey) return null;
  if (event.ctrlKey) return "\x1b[13;5u";
  if (event.metaKey) return "\x1b[13;9u";
  return null;
}

export function isTerminalPasteShortcut(event: TerminalKeyEvent): boolean {
  const key = event.key.toLowerCase();
  const commandModifier = Boolean(event.metaKey || event.ctrlKey) && !event.altKey;
  return (commandModifier && key === "v") || Boolean(event.shiftKey && key === "insert");
}

export function shouldXtermHandleKeyEvent(event: TerminalKeyEvent): boolean {
  return event.type !== "keydown" || (!isTerminalPasteShortcut(event) && !getModifiedEnterSequence(event));
}

export function getTerminalKeyAction(event: TerminalKeyEvent, hasCopySelection: boolean): TerminalKeyAction {
  const key = event.key.toLowerCase();
  const commandModifier = Boolean(event.metaKey || event.ctrlKey) && !event.altKey;

  if ((commandModifier && key === "c" && hasCopySelection) || (event.ctrlKey && key === "insert" && hasCopySelection)) {
    return "copy";
  }

  if (commandModifier && key === "f") {
    return "find";
  }

  return "none";
}
